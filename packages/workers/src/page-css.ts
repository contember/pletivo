/** Scoped Astro CSS ordering and safe HTML insertion. */

import type { InjectedScripts, ModuleId } from "@pletivo/core/artifact";
import { extractAstroScopes } from "@pletivo/core/astro-host/scoped-style";
import { escapeStyleEnd } from "@pletivo/core/inline-style";
import { pageDoctype, type PageDoctypeOptions } from "@pletivo/core/page-doctype";
import type { ResolvedStyleGraph } from "./compiled-program.ts";

export interface PageCssOptions {
  entry: ModuleId;
  graph: ResolvedStyleGraph;
  html: string;
  renderedModules: ReadonlySet<ModuleId>;
}

export function pageCss(options: PageCssOptions): string {
  const scopes = extractAstroScopes(options.html);
  const contributions = new Map<ModuleId, string[]>();

  for (const styles of options.graph.styles) {
    const scoped = scopes.has(styles.scope);
    const rendered = options.renderedModules.has(styles.moduleId);
    if (!scoped && !rendered) continue;
    const css = styles.blocks
      .filter((block) => (block.global ? rendered : scoped))
      .map((block) => block.css);
    if (css.length > 0) contributions.set(styles.moduleId, css);
  }
  if (contributions.size === 0) return "";

  const parts: string[] = [];
  for (const moduleId of orderContributors(contributions, options)) {
    parts.push(...(contributions.get(moduleId) ?? []));
  }
  return parts.join("\n");
}

function orderContributors(
  contributions: ReadonlyMap<ModuleId, readonly string[]>,
  options: PageCssOptions,
): ModuleId[] {
  const remaining = new Set(contributions.keys());
  const ordered: ModuleId[] = [];
  for (const moduleId of moduleOrder(options.entry, options.graph)) {
    if (remaining.delete(moduleId)) ordered.push(moduleId);
  }
  for (const moduleId of options.renderedModules) {
    if (remaining.delete(moduleId)) ordered.push(moduleId);
  }
  const graphOrder = new Map(options.graph.modules.map((moduleId, index) => [moduleId, index]));
  const rest = [...remaining].sort((left, right) => {
    const leftIndex = graphOrder.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = graphOrder.get(right) ?? Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex || (left < right ? -1 : left > right ? 1 : 0);
  });
  return [...ordered, ...rest];
}

/** Executable modules reachable from `entry`, in depth-first post-order. */
export function moduleOrder(entry: ModuleId, graph: ResolvedStyleGraph): ModuleId[] {
  const imports = adjacency(graph.executionEdges);
  const order: ModuleId[] = [];
  const seen = new Set<ModuleId>();
  const visit = (moduleId: ModuleId): void => {
    if (seen.has(moduleId)) return;
    seen.add(moduleId);
    for (const child of imports.get(moduleId) ?? []) visit(child);
    order.push(moduleId);
  };
  visit(entry);
  return order;
}

/** Importer -> its targets, in edge order. */
export function adjacency(
  edges: readonly { importer: ModuleId; target: ModuleId }[],
): Map<ModuleId, ModuleId[]> {
  const byImporter = new Map<ModuleId, ModuleId[]>();
  for (const edge of edges) {
    const targets = byImporter.get(edge.importer);
    if (targets) targets.push(edge.target);
    else byImporter.set(edge.importer, [edge.target]);
  }
  return byImporter;
}

/** `doctypeOptions.compressHTML` is the artifact's, absent for a pletivo-native project. */
export function finalizeHtml(
  html: string,
  doctypeOptions: PageDoctypeOptions,
  css: readonly string[],
  scripts?: InjectedScripts,
): string {
  let out = html;
  // Prepended last: the CSS below may be prepended to a page without `<head>`.
  const doctype = pageDoctype(html, doctypeOptions);
  const parts = css.filter(Boolean);
  if (parts.length > 0) {
    const tag = parts.map((part) => `<style>${escapeStyleEnd(part)}</style>`).join("\n");
    if (out.includes("</head>")) out = out.replace("</head>", () => tag + "\n</head>");
    else if (out.includes("</body>")) out = out.replace("</body>", () => tag + "\n</body>");
    else out = tag + "\n" + out;
  }
  const injected = injectedScriptTags(scripts);
  if (injected && out.includes("</head>")) out = out.replace("</head>", () => injected + "\n</head>");
  return doctype + out;
}

function injectedScriptTags(scripts: InjectedScripts | undefined): string {
  if (!scripts) return "";
  return [
    ...scripts.headInline.map((code) => `<script>${code}</script>`),
    ...scripts.page.map((code) => `<script type="module">${code}</script>`),
  ].join("\n");
}
