/**
 * Server-side renderer for TSX pages using Astro's JSX runtime.
 * Based on MDX's server.ts implementation.
 */
import type { NamedSSRLoadedRendererValue } from 'astro';
import { AstroJSX, jsx } from 'astro/jsx-runtime';
import { renderJSX } from 'astro/runtime/server/index.js';
import { renderToString as reactRenderToString } from 'react-dom/server';
// @ts-ignore - internal Astro module
import { ISLAND_STYLES } from 'astro/runtime/server/astro-island-styles.js';
// @ts-ignore - internal Astro module
import { getPrescripts, determineIfNeedsHydrationScript, determinesIfNeedsDirectiveScript } from 'astro/runtime/server/scripts.js';
import { ASTRO_JSX_RENDERER } from './constants.js';
import { resetIslandCounter } from './react-island-runtime.js';

// Constants
const ASTRO_ISLAND_TAG = '<astro-island';
const ISLAND_PLACEHOLDER_TAG = '<astro-island-placeholder';

// Types
// AstroResult is intentionally loose since we only use a subset of SSRResult
// and the internal Astro functions are @ts-ignored anyway
type AstroResult = {
  resolve?: (path: string) => Promise<string>;
} & Record<string, unknown>;

interface RenderContext {
  result: AstroResult;
}

type ComponentWithReactMarker = {
  [key: symbol]: unknown;
  (...args: unknown[]): unknown;
};

interface PlaceholderAttrs {
  client: string;
  clientValue?: string;
  componentPath: string;
  componentExport: string;
  propsJson: string;
  islandId: string;
}

interface PlaceholderInfo {
  fullMatch: string;
  attrs: PlaceholderAttrs;
  content: string;
  index: number;
}

interface IslandElementConfig {
  uid: string;
  prefix: string;
  client: string;
  clientValue?: string;
  componentUrl: string;
  componentExport: string;
  rendererUrl: string;
  propsJson: string;
  content: string;
}

/**
 * Converts kebab-case or snake_case slot names to camelCase.
 * e.g., "my-slot" -> "mySlot", "my_slot" -> "mySlot"
 */
const normalizeSlotName = (str: string) => str.trim().replace(/[-_]([a-z])/g, (_, w) => w.toUpperCase());

/**
 * Parses data-* attributes from an HTML attribute string.
 */
function parseDataAttributes(attrsStr: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRegex = /data-([a-z-]+)="([^"]*)"/g;
  let match;
  while ((match = attrRegex.exec(attrsStr)) !== null) {
    attrs[match[1]] = match[2];
  }
  return attrs;
}

/**
 * Builds an astro-island element from configuration.
 */
function buildIslandElement(config: IslandElementConfig): string {
  const escapedProps = config.propsJson.replace(/"/g, '&quot;');
  const opts = JSON.stringify({ name: config.componentExport, value: true });
  const escapedOpts = opts.replace(/"/g, '&quot;');

  const attrs = [
    `uid="${config.uid}"`,
    `prefix="${config.prefix}"`,
    `client="${config.client}"`,
    ...(config.clientValue ? [`client-value="${config.clientValue}"`] : []),
    `component-url="${config.componentUrl}"`,
    `component-export="${config.componentExport}"`,
    `renderer-url="${config.rendererUrl}"`,
    `props="${escapedProps}"`,
    'ssr',
    `opts="${escapedOpts}"`,
    'await-children',
  ];

  return `<astro-island ${attrs.join(' ')}>${config.content}<!--astro:end--></astro-island>`;
}

/**
 * Extracts client directives from HTML containing astro-island tags.
 */
function extractDirectivesFromHtml(html: string): Set<string> {
  const directiveMatches = html.matchAll(/<astro-island[^>]*\sclient="([^"]+)"/g);
  const directives = new Set<string>();
  for (const match of directiveMatches) {
    directives.add(match[1]);
  }
  return directives;
}

/**
 * Injects hydration scripts for island directives before the first astro-island tag.
 * Note: result is cast to any because the internal Astro functions are @ts-ignored imports.
 */
function injectHydrationScripts(html: string, directives: Set<string>, result: AstroResult): string {
  let prescripts = '';
  for (const directive of directives) {
    // Cast to any for internal Astro functions that expect SSRResult
    if (determineIfNeedsHydrationScript(result as any)) {
      prescripts += getPrescripts(result as any, 'both', directive);
    } else if (determinesIfNeedsDirectiveScript(result as any, directive)) {
      prescripts += getPrescripts(result as any, 'directive', directive);
    }
  }

  if (prescripts) {
    return html.replace(/(<astro-island\s)/, prescripts + '$1');
  }
  return html;
}

/**
 * Resolves component and renderer URLs using Astro's resolver.
 */
async function resolveIslandUrls(
  componentPath: string,
  result: AstroResult
): Promise<{ componentUrl: string; rendererUrl: string }> {
  let componentUrl = componentPath;
  let rendererUrl = '/_astro/client.js';

  if (result?.resolve) {
    try {
      componentUrl = await result.resolve(decodeURI(componentPath));
    } catch {
      if (componentPath.startsWith('/')) {
        componentUrl = `/@fs${componentPath}`;
      }
    }

    try {
      rendererUrl = await result.resolve('@astrojs/react/client.js');
    } catch {
      // Keep default
    }
  } else if (componentPath.startsWith('/')) {
    componentUrl = `/@fs${componentPath}`;
  }

  return { componentUrl, rendererUrl };
}

/**
 * Converts raw data attributes to typed PlaceholderAttrs.
 */
function toPlaceholderAttrs(raw: Record<string, string>): PlaceholderAttrs {
  return {
    client: raw['client'] || 'load',
    clientValue: raw['client-value'],
    componentPath: raw['component-path'] || '',
    componentExport: raw['component-export'] || 'default',
    propsJson: raw['props'] || '{}',
    islandId: raw['island-id'] || '0',
  };
}

/**
 * Converts <astro-island-placeholder> elements to proper <astro-island> elements.
 * Uses result.resolve() to get bundled asset URLs.
 */
async function convertPlaceholdersToIslands(
  html: string,
  result: AstroResult
): Promise<{ html: string; directives: Set<string> }> {
  const directives = new Set<string>();
  const placeholderRegex = /<astro-island-placeholder\s+([^>]*)>([\s\S]*?)<\/astro-island-placeholder>/g;

  // Collect all placeholders first (can't use async in replace callback)
  const placeholders: PlaceholderInfo[] = [];
  let match;
  while ((match = placeholderRegex.exec(html)) !== null) {
    placeholders.push({
      fullMatch: match[0],
      attrs: toPlaceholderAttrs(parseDataAttributes(match[1])),
      content: match[2],
      index: match.index,
    });
  }

  // Process placeholders in reverse order to preserve indices
  let resultHtml = html;
  for (let i = placeholders.length - 1; i >= 0; i--) {
    const { fullMatch, attrs, content, index } = placeholders[i];

    directives.add(attrs.client);

    const { componentUrl, rendererUrl } = await resolveIslandUrls(attrs.componentPath, result);

    const replacement = buildIslandElement({
      uid: attrs.islandId,
      prefix: `r${attrs.islandId}`,
      client: attrs.client,
      clientValue: attrs.clientValue,
      componentUrl,
      componentExport: attrs.componentExport,
      rendererUrl,
      propsJson: attrs.propsJson,
      content,
    });

    resultHtml = resultHtml.slice(0, index) + replacement + resultHtml.slice(index + fullMatch.length);
  }

  return { html: resultHtml, directives };
}

/**
 * Check if this component should be handled by this renderer.
 * Returns true if the component produces AstroJSX nodes or is tagged as React page.
 */
export async function check(
  Component: ComponentWithReactMarker,
  props: Record<string, unknown>,
  { default: children = null, ...slotted }: Record<string, unknown> = {},
): Promise<boolean> {
  if (typeof Component !== 'function') return false;

  // Check if tagged as React page
  if (Component[Symbol.for('astro-jsx-pages.react')] === true) {
    return true;
  }

  const slots: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(slotted)) {
    slots[normalizeSlotName(key)] = value;
  }

  try {
    const result = (await Component({ ...props, ...slots, children })) as { [AstroJSX]?: boolean };
    return result[AstroJSX] === true;
  } catch {
    return false;
  }
}

/**
 * Renders a React page component with island hydration support.
 */
async function renderReactPage(
  Component: ComponentWithReactMarker,
  props: Record<string, unknown>,
  children: unknown,
  result: AstroResult
): Promise<{ html: string }> {
  resetIslandCounter();

  const React = await import('react');
  // Cast to any for React.createElement since Component is a generic function type
  const element = React.createElement(Component as any, { ...props, children });
  let html = '<!DOCTYPE html>' + reactRenderToString(element);

  if (html.includes(ISLAND_PLACEHOLDER_TAG)) {
    const { html: convertedHtml, directives } = await convertPlaceholdersToIslands(html, result);
    html = injectHydrationScripts(convertedHtml, directives, result);
  }

  return { html };
}

/**
 * Renders an Astro JSX page component with island hydration support.
 */
async function renderAstroPage(
  Component: ComponentWithReactMarker,
  props: Record<string, unknown>,
  slots: Record<string, unknown>,
  children: unknown,
  result: AstroResult
): Promise<{ html: string }> {
  // Cast to any for renderJSX since it expects SSRResult
  let html = await renderJSX(result as any, jsx(Component as any, { ...props, ...slots, children }));

  // Workaround: renderJSX loses SlotString instructions when rendering elements,
  // so hydration scripts are not injected. We manually inject them here.
  const htmlStr = String(html);
  if (htmlStr.includes(ASTRO_ISLAND_TAG)) {
    const directives = extractDirectivesFromHtml(htmlStr);
    html = injectHydrationScripts(htmlStr, directives, result);
  }

  return { html };
}

/**
 * Render the component to static HTML markup.
 */
export async function renderToStaticMarkup(
  this: RenderContext,
  Component: ComponentWithReactMarker,
  props: Record<string, unknown> = {},
  { default: children = null, ...slotted }: Record<string, unknown> = {},
): Promise<{ html: string }> {
  const { result } = this;

  // Handle React pages (those with @jsxImportSource react)
  if (Component[Symbol.for('astro-jsx-pages.react')] === true) {
    return renderReactPage(Component, props, children, result);
  }

  const slots: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(slotted)) {
    slots[normalizeSlotName(key)] = value;
  }

  return renderAstroPage(Component, props, slots, children, result);
}

const renderer: NamedSSRLoadedRendererValue = {
  name: ASTRO_JSX_RENDERER,
  check,
  renderToStaticMarkup,
};

export default renderer;
