/** Page-scoped stylesheet assembly over the canonical resolved module graph. */

import type { InjectedScripts, ModuleId } from "@pletivo/core/artifact";
import type { ResolvedStyleGraph } from "./compiled-program.ts";
import { moduleOrder } from "./page-css.ts";
import {
  compileTailwind,
  extractHtmlClassCandidates,
  extractCandidates,
  type TailwindStylesheets,
} from "./tailwind.ts";

export interface PageStylesheetOptions {
  /** Project paths and artifact ModuleIds mapped to their source text. */
  files: ReadonlyMap<string, string>;
  srcDir: string;
  rootDir: string;
  /** Canonical graph shared with executable compilation. */
  styleGraph: ResolvedStyleGraph;
  /** Logical ModuleId of the rendering page. */
  entry: ModuleId;
  html: string;
  scripts?: InjectedScripts;
  tailwind?: TailwindStylesheets;
}

export class TailwindNotConfiguredError extends Error {
  constructor(readonly entry: string) {
    super(
      `[pletivo-workers] ${JSON.stringify(entry)} imports Tailwind, but renderPage() was ` +
        "given no `tailwind` stylesheets. The isolate cannot read them off disk.",
    );
    this.name = "TailwindNotConfiguredError";
  }
}

const CSS = ".css";
const CSS_MODULE = ".module.css";
const PREFERRED_ENTRIES = ["global.css", "app.css", "main.css", "styles.css"];
const IMPORTS_TAILWIND = /@import\s+(?:url\(\s*)?["']tailwindcss["']\s*\)?/i;

export function isCollectableCss(moduleId: string): boolean {
  return moduleId.endsWith(CSS) && !moduleId.endsWith(CSS_MODULE);
}

export async function pageStylesheet(options: PageStylesheetOptions): Promise<string | null> {
  const ordered = orderedStylesheets(options.entry, options.styleGraph);
  const sources = ordered.flatMap((moduleId) => {
    if (isUnsupportedProjectCssModule(moduleId)) return [];
    const content = sourceFor(moduleId, options.files);
    return content === undefined ? [] : [{ moduleId, content }];
  });
  if (sources.length === 0) return null;

  const entry = findTailwindEntry(sources);
  if (!entry) return emitStylesheets(sources, options);
  if (!options.tailwind) throw new TailwindNotConfiguredError(entry.moduleId);

  const candidates = new Set(extractHtmlClassCandidates(options.html));
  for (const script of options.scripts?.headInline ?? []) {
    for (const candidate of extractCandidates(script)) candidates.add(candidate);
  }
  for (const script of options.scripts?.page ?? []) {
    for (const candidate of extractCandidates(script)) candidates.add(candidate);
  }

  const compilation = await compileTailwind({
    entry: entry.moduleId,
    files: options.files,
    stylesheets: options.tailwind,
    candidates: [...candidates],
    styleTargets: styleTargets(options.styleGraph),
    embeddedTargets: embeddedTargets(options.styleGraph, options.files, options.tailwind),
  });
  const consumed = new Set(compilation.consumedStylesheets);
  const parts: string[] = [];
  let inserted = false;
  for (const moduleId of ordered) {
    if (!consumed.has(moduleId)) {
      if (isUnsupportedProjectCssModule(moduleId)) continue;
      const content = sourceFor(moduleId, options.files);
      if (content !== undefined) parts.push(emitStylesheets([{ moduleId, content }], options));
      continue;
    }
    if (!inserted) {
      parts.push(compilation.css);
      inserted = true;
    }
  }
  return parts.filter(Boolean).join("\n\n");
}

interface StylesheetSource {
  moduleId: ModuleId;
  content: string;
}

function orderedStylesheets(entry: ModuleId, graph: ResolvedStyleGraph): ModuleId[] {
  const stylesByImporter = adjacency(graph.styleEdges);
  const execution = moduleOrder(entry, graph);
  const ordered: ModuleId[] = [];
  const seen = new Set<ModuleId>();

  const visitStyle = (moduleId: ModuleId): void => {
    if (seen.has(moduleId)) return;
    seen.add(moduleId);
    for (const dependency of stylesByImporter.get(moduleId) ?? []) visitStyle(dependency);
    ordered.push(moduleId);
  };
  for (const moduleId of execution) {
    for (const stylesheet of stylesByImporter.get(moduleId) ?? []) visitStyle(stylesheet);
  }
  return ordered;
}

function isUnsupportedProjectCssModule(moduleId: ModuleId): boolean {
  return moduleId.startsWith("project:") && moduleId.endsWith(CSS_MODULE);
}

function adjacency(
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

function styleTargets(graph: ResolvedStyleGraph): ReadonlyMap<ModuleId, readonly ModuleId[]> {
  return adjacency(graph.styleEdges);
}

function embeddedTargets(
  graph: ResolvedStyleGraph,
  files: ReadonlyMap<string, string>,
  stylesheets: TailwindStylesheets,
): ReadonlyMap<ModuleId, keyof TailwindStylesheets> {
  const embedded = new Map<ModuleId, keyof TailwindStylesheets>();
  const entries = Object.entries(stylesheets);
  for (const edge of graph.styleEdges) {
    const source = sourceFor(edge.target, files);
    if (source === undefined) continue;
    for (const [specifier, content] of entries) {
      if (source === content) embedded.set(edge.target, tailwindSpecifier(specifier));
    }
  }
  return embedded;
}

function tailwindSpecifier(value: string): keyof TailwindStylesheets {
  if (
    value === "tailwindcss" ||
    value === "tailwindcss/preflight" ||
    value === "tailwindcss/theme" ||
    value === "tailwindcss/utilities"
  ) return value;
  throw new Error(`[pletivo-workers] unknown embedded Tailwind stylesheet ${JSON.stringify(value)}`);
}

function sourceFor(moduleId: ModuleId, files: ReadonlyMap<string, string>): string | undefined {
  if (moduleId.startsWith("project:")) return files.get(moduleId.slice("project:".length));
  return files.get(moduleId);
}

function emitStylesheets(
  stylesheets: readonly StylesheetSource[],
  options: Pick<PageStylesheetOptions, "srcDir" | "rootDir">,
): string {
  return stylesheets
    .map((stylesheet) => `/* ${labelFor(stylesheet.moduleId, options)} */\n${stylesheet.content}`)
    .join("\n\n");
}

function labelFor(
  moduleId: ModuleId,
  options: Pick<PageStylesheetOptions, "srcDir" | "rootDir">,
): string {
  if (!moduleId.startsWith("project:")) return moduleId;
  const file = moduleId.slice("project:".length);
  const sourcePrefix = withSlash(options.srcDir);
  if (file.startsWith(sourcePrefix)) return file.slice(sourcePrefix.length);
  const rootPrefix = withSlash(options.rootDir);
  return file.startsWith(rootPrefix) ? file.slice(rootPrefix.length) : file;
}

function findTailwindEntry(sources: readonly StylesheetSource[]): StylesheetSource | null {
  const ranked = [...sources].sort((left, right) => {
    const leftRank = PREFERRED_ENTRIES.indexOf(basename(left.moduleId));
    const rightRank = PREFERRED_ENTRIES.indexOf(basename(right.moduleId));
    if (leftRank !== -1 && rightRank !== -1) return leftRank - rightRank;
    if (leftRank !== -1) return -1;
    if (rightRank !== -1) return 1;
    return left.moduleId < right.moduleId ? -1 : left.moduleId > right.moduleId ? 1 : 0;
  });
  return ranked.find((source) => IMPORTS_TAILWIND.test(source.content)) ?? null;
}

export function tailwindEntry(options: {
  files: ReadonlyMap<string, string>;
  srcDir: string;
}): string | null {
  const prefix = withSlash(options.srcDir);
  const sources: StylesheetSource[] = [];
  for (const [file, content] of options.files) {
    if (!file.startsWith(prefix) || !isCollectableCss(file)) continue;
    sources.push({ moduleId: file, content });
  }
  return findTailwindEntry(sources)?.moduleId ?? null;
}

function withSlash(directory: string): string {
  return directory === "" ? "" : `${directory}/`;
}

function basename(file: string): string {
  const at = file.lastIndexOf("/");
  return at === -1 ? file : file.slice(at + 1);
}

export function parentDir(directory: string): string {
  const at = directory.lastIndexOf("/");
  return at === -1 ? "" : directory.slice(0, at);
}
