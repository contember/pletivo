/** Scoped Astro CSS ordering and safe HTML insertion. */

import type { InjectedScripts, ModuleId } from "@pletivo/core/artifact";
import type { ResolvedStyleGraph } from "./compiled-program.ts";

export interface PageCssOptions {
  entry: ModuleId;
  graph: ResolvedStyleGraph;
  html: string;
  renderedModules: ReadonlySet<ModuleId>;
}

export function pageCss(options: PageCssOptions): string {
  const classes = extractAstroClasses(options.html);
  const contributions = new Map<ModuleId, string[]>();

  for (const styles of options.graph.styles) {
    const scoped = classes.has(`astro-${styles.scope}`);
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
  const imports = new Map<ModuleId, ModuleId[]>();
  for (const edge of graph.executionEdges) {
    const targets = imports.get(edge.importer);
    if (targets) targets.push(edge.target);
    else imports.set(edge.importer, [edge.target]);
  }
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

export function extractAstroClasses(html: string): Set<string> {
  return new Set(html.match(/astro-[a-z0-9]+/g) ?? []);
}

export function finalizeHtml(
  html: string,
  css: readonly string[],
  scripts?: InjectedScripts,
): string {
  let out = html;
  if (out.trimStart().startsWith("<html") && !out.trimStart().startsWith("<!")) {
    out = "<!DOCTYPE html>\n" + out;
  }
  const parts = css.filter(Boolean);
  if (parts.length > 0) {
    const tag = parts.map((part) => `<style>${escapeInlineStyle(part)}</style>`).join("\n");
    if (out.includes("</head>")) out = out.replace("</head>", tag + "\n</head>");
    else if (out.includes("</body>")) out = out.replace("</body>", tag + "\n</body>");
    else out = tag + "\n" + out;
  }
  const injected = injectedScriptTags(scripts);
  if (injected && out.includes("</head>")) out = out.replace("</head>", injected + "\n</head>");
  return out;
}

function escapeInlineStyle(css: string): string {
  return css.replace(/<\/style/gi, "\\3C /style");
}

function injectedScriptTags(scripts: InjectedScripts | undefined): string {
  if (!scripts) return "";
  return [
    ...scripts.headInline.map((code) => `<script>${code}</script>`),
    ...scripts.page.map((code) => `<script type="module">${code}</script>`),
  ].join("\n");
}
