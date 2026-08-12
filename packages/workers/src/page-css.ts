/**
 * The `<style>` blocks a rendered page needs, in the order they cascade.
 *
 * A port of the Bun host's `getAstroCssForPage` (`astro-plugin.ts`) and the walk in
 * `astro-css-order.ts`, reading the import graph `compileProject` already built
 * instead of the filesystem. The order is not a free choice — it is what decides
 * which rule wins — so the two hosts have to agree on it:
 *
 *   - a page's own `<style>` lands after the CSS of the components it imports;
 *   - siblings follow the importer's *import* order, not their render order;
 *   - a deeper component precedes the component that imports it;
 *   - a module reached twice keeps its first position.
 *
 * That is a depth-first post-order walk of the static import graph rooted at the page.
 */

import type { InjectedScripts } from "@pletivo/core/artifact";
import type { AstroStyles } from "./compile-project.ts";

export interface PageCssOptions {
  /** The page's project path — the root of the walk. */
  entry: string;
  /** Project path -> its `<style>` blocks. */
  styles: ReadonlyMap<string, AstroStyles>;
  /** Project path -> the project paths it imports, in execution order. */
  imports: ReadonlyMap<string, string[]>;
  /** The rendered HTML, read for `astro-{scope}` classes. */
  html: string;
  /** Module ids whose render function ran, reported by the isolate. */
  renderedModules: ReadonlySet<string>;
}

/**
 * Concatenated CSS for one page, or `""`.
 *
 * A component contributes when the page shows it, and each of its blocks is gated
 * separately because the two kinds are visible in different ways: a scoped block by
 * its `astro-{scope}` class appearing in the HTML, an `is:global` block by the
 * component having rendered at all — a global-only component emits no scoped DOM,
 * so class presence cannot see it.
 */
export function pageCss(options: PageCssOptions): string {
  const { entry, styles, imports, html, renderedModules } = options;
  const classes = extractAstroClasses(html);
  const contributions = new Map<string, string[]>();

  for (const [file, entryStyles] of styles) {
    const scoped = classes.has(`astro-${entryStyles.scope}`);
    const rendered = renderedModules.has(file);
    if (!scoped && !rendered) continue;
    const css = entryStyles.blocks
      .filter((block) => (block.global ? rendered : scoped))
      .map((block) => block.css);
    if (css.length > 0) contributions.set(file, css);
  }
  if (contributions.size === 0) return "";

  const parts: string[] = [];
  for (const file of orderContributors([...contributions.keys()], entry, imports, renderedModules)) {
    parts.push(...contributions.get(file)!);
  }
  return parts.join("\n");
}

function orderContributors(
  files: string[],
  entry: string,
  imports: ReadonlyMap<string, string[]>,
  renderedModules: ReadonlySet<string>,
): string[] {
  if (files.length < 2) return files;
  const remaining = new Set(files);
  const ordered: string[] = [];
  for (const file of moduleOrder(entry, imports)) {
    if (remaining.delete(file)) ordered.push(file);
  }
  if (remaining.size === 0) return ordered;
  // Whatever the walk could not reach. Fall back to the order the components
  // rendered in — a real property of this page — then to the path, so the result
  // never depends on the order the map happened to be iterated in.
  const rendered = [...renderedModules].filter((file) => remaining.has(file));
  const rest = [...remaining].filter((file) => !renderedModules.has(file)).sort();
  return [...ordered, ...rendered, ...rest];
}

/** Modules reachable from `entry`, in the order their CSS executes. */
export function moduleOrder(entry: string, imports: ReadonlyMap<string, string[]>): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const child of imports.get(file) ?? []) visit(child);
    order.push(file);
  };
  visit(entry);
  return order;
}

/** Every `astro-XXXXX` scope class in an HTML string. */
export function extractAstroClasses(html: string): Set<string> {
  return new Set(html.match(/astro-[a-z0-9]+/g) ?? []);
}

/**
 * The last step the Bun host's `writeHtml` takes before a page hits disk: give it a
 * doctype if the template did not, link the project stylesheet, then put the page's
 * own CSS in the head.
 *
 * The two go in that order, and it is the order `writeHtml` produces: both insert
 * before `</head>`, the `<link>` first, so the `<style>` lands after it and a
 * component's scoped rule outranks the bundle. The `<link>` has no `</body>`
 * fallback — a page with no `<head>` gets no stylesheet on either host.
 *
 * `scripts` are what `injectScript()` produced during `astro:config:setup`, frozen
 * into the site artifact. They land last and only in `<head>`, which is `writeHtml`'s
 * own order and its own restriction: a page with no `</head>` gets none of them on
 * either host. `before-hydration` is deliberately absent — `writeHtml` emits those
 * only for a page carrying islands, and this host has none.
 *
 * Not ported from `writeHtml`, because there is no build pipeline behind them here:
 * hashed public-asset rewriting, CSS modules and the island hydration runtime.
 */
export function finalizeHtml(
  html: string,
  css: string,
  stylesheet: string | null = null,
  scripts?: InjectedScripts,
): string {
  let out = html;
  if (out.trimStart().startsWith("<html") && !out.trimStart().startsWith("<!")) {
    out = "<!DOCTYPE html>\n" + out;
  }
  if (stylesheet && out.includes("</head>")) {
    out = out.replace("</head>", `<link rel="stylesheet" href="${stylesheet}">\n</head>`);
  }
  if (css) {
    const tag = `<style>${css}</style>`;
    if (out.includes("</head>")) out = out.replace("</head>", tag + "\n</head>");
    else if (out.includes("</body>")) out = out.replace("</body>", tag + "\n</body>");
    else out = tag + "\n" + out;
  }
  const injected = injectedScriptTags(scripts);
  if (injected && out.includes("</head>")) out = out.replace("</head>", injected + "\n</head>");
  return out;
}

/** The tags `build.ts:1391` writes, in its order: inline first, then module. */
function injectedScriptTags(scripts: InjectedScripts | undefined): string {
  if (!scripts) return "";
  return [
    ...scripts.headInline.map((code) => `<script>${code}</script>`),
    ...scripts.page.map((code) => `<script type="module">${code}</script>`),
  ].join("\n");
}
