/**
 * Astro 5.16.11's `renderFrameworkComponent`. The `check` order and the objects passed to it
 * are part of the output: React's `check` spends a prefix id, Preact's rewrites signal props.
 */
import { createHtml, type HtmlString } from "../html-string";
import {
  TRANSITION_ATTRIBUTES,
  escapeHtml,
  extractDirectives,
  normalizeProps,
  renderElement,
  type Hydration,
} from "./hydration";
import { islandPrescripts, takePrescripts } from "./prescripts";
import { serializeProps } from "./serialize";
import { shorthash } from "./shorthash";
import type {
  AstroIslandsConfig,
  FrameworkComponentCall,
  LoadedRenderer,
  RenderedSlots,
  RendererMarkup,
  RendererMetadata,
} from "./types";

type RenderValue = (value: unknown) => Promise<string>;

const RENDERER_TAG = Symbol.for("astro:renderer");
const rendererAliases = new Map([["solid", "solid-js"]]);
const clientOnlyValues: ReadonlySet<unknown> = new Set(["solid-js", "react", "preact", "vue", "svelte"]);

function guessRenderers(componentUrl: string | undefined): string[] {
  switch (componentUrl?.split(".").pop()) {
    case "svelte":
      return ["@astrojs/svelte"];
    case "vue":
      return ["@astrojs/vue"];
    case "jsx":
    case "tsx":
      return ["@astrojs/react", "@astrojs/preact", "@astrojs/solid-js", "@astrojs/vue (jsx)"];
    default:
      return ["@astrojs/react", "@astrojs/preact", "@astrojs/solid-js", "@astrojs/vue", "@astrojs/svelte"];
  }
}

function formatList(values: string[]): string {
  if (values.length === 1) return values[0] ?? "";
  return `${values.slice(0, -1).join(", ")} or ${values[values.length - 1]}`;
}

function rendererNameOf(hint: unknown): unknown {
  return typeof hint === "string" ? (rendererAliases.get(hint) ?? hint) : hint;
}

/** Astro's `NoMatchingRenderer`, naming the directive as well. */
function noMatchingRenderer(metadata: RendererMetadata, validCount: number, probable: string[]): Error {
  const plural = validCount > 1;
  const extension = metadata.componentUrl?.split(".").pop();
  const detail =
    validCount > 0
      ? `There ${plural ? "are" : "is"} ${validCount} renderer${plural ? "s" : ""} configured in your \`astro.config.mjs\` file,
but ${plural ? "none were" : "it was not"} able to server-side render \`${metadata.displayName}\`.`
      : `No valid renderer was found ${extension ? `for the \`.${extension}\` file extension.` : "for this file extension."}`;
  return new Error(
    `Unable to render \`${metadata.displayName}\` with \`client:${metadata.hydrate}\`.

${detail}

Did you mean to enable the ${formatList(probable.map((r) => "`" + r + "`"))} integration?

See https://docs.astro.build/en/guides/framework-components/ for more information on how to install and configure integrations.`,
  );
}

function noClientOnlyHint(metadata: RendererMetadata, probable: string[]): Error {
  return new Error(
    `Unable to render \`${metadata.displayName}\`. When using the \`client:only\` hydration strategy, Astro needs a hint to use the correct renderer.

Did you mean to pass \`client:only="${probable.map((r) => r.replace("@astrojs/", "")).join("|")}"\`? See https://docs.astro.build/en/reference/directives-reference/#clientonly for more information on client:only`,
  );
}

function ambiguousRenderer(metadata: RendererMetadata, probable: string[]): Error {
  return new Error(`Unable to render ${metadata.displayName} with \`client:${metadata.hydrate}\`!

This component likely uses ${formatList(probable)},
but Astro encountered an error during server-side rendering.

Please ensure that ${metadata.displayName}:
1. Does not unconditionally access browser-specific globals like \`window\` or \`document\`.
   If this is unavoidable, use the \`client:only\` hydration directive.
2. Does not conditionally return \`null\` or \`undefined\` when rendered on the server.`);
}

const ASTRO_SLOT = /<\/?astro-slot\b[^>]*>/g;
const ASTRO_STATIC_SLOT = /<\/?astro-static-slot\b[^>]*>/g;

function removeStaticAstroSlot(html: string, supportsAstroStaticSlot: boolean): string {
  return html.replace(supportsAstroStaticSlot ? ASTRO_STATIC_SLOT : ASTRO_SLOT, "");
}

interface SlotRender {
  children: RenderedSlots;
  /** Prescripts of islands inside the slots, written ahead of the component. */
  prescripts: string;
}

/** Astro's `renderSlots`: every slot rendered to a string before any renderer sees the component. */
async function renderAstroSlots(call: FrameworkComponentCall, renderValue: RenderValue): Promise<SlotRender> {
  const rendered = await Promise.all(
    Object.entries(call.slots).map(async ([name, slot]) => ({ name, ...takePrescripts(await renderValue(slot())) })),
  );
  const children: RenderedSlots = {};
  let prescripts = "";
  for (const slot of rendered) {
    children[slot.name] = new String(slot.html);
    prescripts += slot.prescripts;
  }
  return { children, prescripts };
}

/** Astro's `renderJSX`: `children` becomes the default slot, dropped when it renders to whitespace. */
async function renderJsxChildren(children: unknown, renderValue: RenderValue): Promise<SlotRender> {
  const slot = takePrescripts(await renderValue(children));
  if (slot.html.trim().length === 0) return { children: {}, prescripts: "" };
  return { children: { default: new String(slot.html) }, prescripts: slot.prescripts };
}

function taggedRenderer(Component: unknown, renderers: readonly LoadedRenderer[]): LoadedRenderer | undefined {
  if ((typeof Component !== "function" && typeof Component !== "object") || Component === null) return undefined;
  let name: unknown;
  try {
    name = Reflect.get(Component, RENDERER_TAG);
  } catch {
    // A Proxy component may throw on an unknown key; Astro ignores it too.
  }
  return name ? renderers.find((r) => r.name === name) : undefined;
}

function clientOnlyRenderer(
  metadata: RendererMetadata,
  renderers: readonly LoadedRenderer[],
  validRenderers: readonly LoadedRenderer[],
): LoadedRenderer | undefined {
  let renderer: LoadedRenderer | undefined;
  if (metadata.hydrateArgs) {
    const name = rendererNameOf(metadata.hydrateArgs);
    if (clientOnlyValues.has(name)) renderer = renderers.find((r) => r.name === `@astrojs/${name}` || r.name === name);
  }
  if (!renderer && validRenderers.length === 1) renderer = validRenderers[0];
  if (!renderer) {
    const extension = metadata.componentUrl?.split(".").pop();
    renderer = renderers.find((r) => r.name === `@astrojs/${extension}` || r.name === extension);
  }
  return renderer;
}

interface IslandInput {
  config: AstroIslandsConfig;
  renderer: LoadedRenderer;
  hydration: Hydration;
  metadata: RendererMetadata;
  props: Record<string, unknown>;
  markup: RendererMarkup;
  children: RenderedSlots;
}

/** Astro's `generateHydrateScript` plus the island tail from `renderFrameworkComponent`. */
function renderIsland({ config, renderer, hydration, metadata, props, markup, children }: IslandInput): string {
  const { componentUrl, componentExport } = hydration;
  const html = markup.html;
  const serializedProps = serializeProps(props, metadata);
  const uid = shorthash(`<!--${componentExport.value}:${componentUrl}-->\n${html}\n${serializedProps}`);
  if (!componentExport.value) {
    throw new Error(
      `Could not render \`${metadata.displayName}\`. No matching import has been found for \`${metadata.displayName}\`.`,
    );
  }

  const island: Record<string, unknown> = { uid };
  // String(): a renderer may set a non-string attr, e.g. React's `data-react-children`.
  for (const [key, value] of Object.entries(markup.attrs ?? {})) island[key] = escapeHtml(String(value));
  island["component-url"] = config.urls.component(decodeURI(componentUrl), componentExport.value);
  if (renderer.clientEntrypoint) {
    island["component-export"] = componentExport.value;
    island["renderer-url"] = config.urls.renderer(renderer.name);
    island["props"] = escapeHtml(serializedProps);
  }
  island["ssr"] = "";
  island["client"] = hydration.directive;
  if (config.urls.beforeHydration) island["before-hydration-url"] = config.urls.beforeHydration;
  island["opts"] = escapeHtml(JSON.stringify({ name: metadata.displayName, value: metadata.hydrateArgs || "" }));
  for (const name of TRANSITION_ATTRIBUTES) {
    if (typeof props[name] !== "undefined") island[name] = props[name];
  }

  // A slot the renderer did not place in its markup travels as a template for the client.
  const slotTag = renderer.ssr.supportsAstroStaticSlot && !metadata.hydrate ? "astro-static-slot" : "astro-slot";
  const unrendered = html
    ? Object.keys(children).filter(
        (key) => !html.includes(key === "default" ? `<${slotTag}>` : `<${slotTag} name="${key}">`),
      )
    : Object.keys(children);
  const templates = unrendered
    .map((key) => `<template data-astro-template${key !== "default" ? `="${key}"` : ""}>${children[key]}</template>`)
    .join("");

  let content = `${html}${templates}`;
  if (content) {
    island["await-children"] = "";
    content += "<!--astro:end-->";
  }
  return renderElement("astro-island", island, content);
}

/**
 * Render `call` as Astro does, or resolve to `null` when no renderer claims a component
 * that is not hydrated, so pletivo renders it itself.
 */
export async function renderFrameworkCall(
  call: FrameworkComponentCall,
  config: AstroIslandsConfig,
  renderValue: RenderValue,
): Promise<HtmlString | null> {
  const { result, Component } = call;
  const { renderers } = config;
  const { children: jsxChildren, ...jsxProps } = call.props;
  const inputProps = normalizeProps(call.source === "jsx" ? jsxProps : call.props);
  const { hydration, isPage, props, propsWithoutTransitionAttributes } = extractDirectives(
    inputProps,
    new Set(Object.keys(config.scripts.directives)),
  );

  const clientOnly = "client:only" in inputProps;
  // Astro's MDX names a client:only element by `client:display-name`, not by the component.
  const displayName =
    call.source === "jsx" && clientOnly ? String(inputProps["client:display-name"] ?? "") : call.displayName;

  if (!Component && !clientOnly) {
    if (!hydration) return null;
    throw new Error(
      `Unable to render ${displayName} because it is ${String(Component)}!\nDid you forget to import the component or is it possible there is a typo?`,
    );
  }

  const metadata: RendererMetadata = { astroStaticSlot: true, displayName };
  if (hydration) {
    metadata.hydrate = hydration.directive;
    metadata.hydrateArgs = hydration.value;
    metadata.componentExport = hydration.componentExport;
    metadata.componentUrl = hydration.componentUrl;
  }

  const validRenderers = renderers.filter((r) => r.name !== "astro:jsx");
  const slots =
    call.source === "jsx" ? await renderJsxChildren(jsxChildren, renderValue) : await renderAstroSlots(call, renderValue);
  const { children } = slots;

  let renderer: LoadedRenderer | undefined;
  let markup: RendererMarkup = { html: "" };
  if (metadata.hydrate !== "only") {
    renderer = taggedRenderer(Component, renderers);
    if (!renderer) {
      let checkError: { error: unknown } | null = null;
      for (const r of renderers) {
        try {
          if (await r.ssr.check.call({ result }, Component, props, children)) {
            renderer = r;
            break;
          }
        } catch (error) {
          checkError ??= { error };
        }
      }
      // pletivo renders an unclaimed static component, and a tag-name string even when hydrated.
      if (!renderer && (!hydration || typeof Component === "string")) return null;
      if (!renderer && checkError) throw checkError.error;
    }
  } else {
    renderer = clientOnlyRenderer(metadata, renderers, validRenderers);
  }

  if (!renderer) {
    const probable = guessRenderers(metadata.componentUrl);
    if (metadata.hydrate === "only") {
      if (clientOnlyValues.has(rendererNameOf(metadata.hydrateArgs))) {
        throw noMatchingRenderer(metadata, validRenderers.length, probable);
      }
      throw noClientOnlyHint(metadata, probable);
    }
    const matching = validRenderers.filter((r) => probable.includes(r.name));
    const [only] = matching;
    if (matching.length > 1) throw ambiguousRenderer(metadata, probable);
    if (!only) throw noMatchingRenderer(metadata, validRenderers.length, probable);
    // Every check failed; Astro renders with the one likely renderer anyway, for its error.
    renderer = only;
    markup = await renderer.ssr.renderToStaticMarkup.call(
      { result },
      Component,
      propsWithoutTransitionAttributes,
      children,
      metadata,
    );
  } else if (metadata.hydrate === "only") {
    // Astro renders the fallback a second time here; that render's prescripts are lost.
    const fallback = call.slots["fallback"];
    markup = { html: fallback ? takePrescripts(await renderValue(fallback())).html : "" };
  } else {
    markup = await renderer.ssr.renderToStaticMarkup.call(
      { result },
      Component,
      propsWithoutTransitionAttributes,
      children,
      metadata,
    );
  }

  if (!hydration) {
    const html =
      isPage || renderer.name === "astro:jsx"
        ? markup.html
        : markup.html
          ? removeStaticAstroSlot(markup.html, renderer.ssr.supportsAstroStaticSlot !== false)
          : "";
    return createHtml(slots.prescripts + html);
  }

  const element = renderIsland({ config, renderer, hydration, metadata, props, markup, children });
  return createHtml(slots.prescripts + islandPrescripts(config, hydration.directive, renderer) + element);
}
