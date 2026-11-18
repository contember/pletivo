/** Page-scoped stylesheet assembly over the canonical resolved module graph. */

import { TAILWIND_RUNTIME_MODULE_ID, type InjectedScripts, type ModuleId } from "@pletivo/core/artifact";
import { cssImports, withoutCssImports } from "@pletivo/core/css-imports";
import type { ResolvedStyleGraph } from "./compiled-program.ts";
import { rewriteCssAssets, type CssAssetLink, type ReadProjectBytes } from "./css-assets.ts";
import { adjacency, edgesOfKind } from "./page-css.ts";
import type { ProjectFiles } from "./project-store.ts";
import {
  compileTailwind,
  extractHtmlClassCandidates,
  extractCandidates,
  fileKeyFor,
  isTailwindStylesheetSpecifier,
  sourceFor,
  tailwindModule,
  TailwindNotConfiguredError,
  type CompileTailwindOptions,
  type TailwindCompilation,
  type TailwindModule,
  type TailwindStylesheets,
} from "./tailwind.ts";
import { compileTailwindInIsolate, type TailwindIsolateHost, type TailwindModuleSource } from "./tailwind-isolate.ts";
import { unreachableTailwindModule } from "./tailwind-isolate-protocol.ts";

export { TailwindNotConfiguredError };

export interface PageStylesheetOptions {
  /** Project paths and artifact ModuleIds mapped to their source text. */
  files: ProjectFiles;
  /** A project file's bytes: what a stylesheet's relative `url()` names. */
  readBytes: ReadProjectBytes;
  /** The artifact's compiled component stylesheets, which sit under `srcDir` and are still bundled. */
  islandStylesheets: ReadonlySet<ModuleId>;
  srcDir: string;
  rootDir: string;
  /** Canonical graph shared with executable compilation. */
  styleGraph: ResolvedStyleGraph;
  /** Logical ModuleId of the rendering page. */
  entry: ModuleId;
  html: string;
  scripts?: InjectedScripts;
  /** Browser code the page loads but its HTML does not hold: processed `<script>` graphs. */
  browserSources?: readonly string[];
  tailwind?: TailwindStylesheets;
  /** Where a closure with `@plugin` or `@config` compiles; the host cannot run those modules. */
  tailwindIsolate?: TailwindIsolateHost;
  /** Vite's `build.assetsInlineLimit`: a `url()` target below it is inlined as a `data:` URI. */
  assetsInlineLimit: number;
}

const CSS_MODULE = ".module.css";
const PREFERRED_ENTRIES = ["global.css", "app.css", "main.css", "styles.css"];

/** The page's stylesheet, and the files its `url()`s now link to. */
export interface PageStylesheet {
  css: string;
  cssAssets: CssAssetLink[];
}

export async function pageStylesheet(options: PageStylesheetOptions): Promise<PageStylesheet | null> {
  const ordered = orderedStylesheets(options.entry, options.styleGraph);
  const sources = ordered.flatMap((moduleId) => {
    if (isUnsupportedProjectCssModule(moduleId)) return [];
    const content = sourceFor(moduleId, options.files);
    return content === undefined ? [] : [{ moduleId, content }];
  });
  if (sources.length === 0) return null;

  const emitted = new Map<string, CssAssetLink>();
  const entry = findTailwindEntry(sources);
  if (!entry) return { css: emitStylesheets(sources, options, emitted), cssAssets: [...emitted.values()] };
  if (!options.tailwind) throw new TailwindNotConfiguredError(entry.moduleId);

  const candidates = new Set(extractHtmlClassCandidates(options.html));
  for (const script of options.scripts?.headInline ?? []) {
    for (const candidate of extractCandidates(script)) candidates.add(candidate);
  }
  for (const script of options.scripts?.page ?? []) {
    for (const candidate of extractCandidates(script)) candidates.add(candidate);
  }
  for (const source of options.browserSources ?? []) {
    for (const candidate of extractCandidates(source)) candidates.add(candidate);
  }

  const compilation = await compileEntry(options, {
    entry: entry.moduleId,
    files: options.files,
    stylesheets: options.tailwind,
    candidates: [...candidates],
    styleTargets: adjacency(edgesOfKind(options.styleGraph, "style")),
    embeddedTargets: embeddedTargets(options.styleGraph, options.files, options.tailwind),
  });
  const consumed = new Set(compilation.consumedStylesheets);
  const parts: string[] = [];
  let inserted = false;
  for (const moduleId of ordered) {
    if (!consumed.has(moduleId)) {
      if (isUnsupportedProjectCssModule(moduleId)) continue;
      const content = sourceFor(moduleId, options.files);
      if (content !== undefined) parts.push(emitStylesheets([{ moduleId, content }], options, emitted));
      continue;
    }
    if (!inserted) {
      parts.push(compilation.css);
      inserted = true;
    }
  }
  return { css: parts.filter(Boolean).join("\n\n"), cssAssets: [...emitted.values()] };
}

/**
 * In the host, unless the entry's `@import` closure has a `@plugin` or `@config` rule:
 * then in the Tailwind isolate, which is the only place those modules can run.
 */
async function compileEntry(
  options: PageStylesheetOptions,
  compile: CompileTailwindOptions,
): Promise<TailwindCompilation> {
  const closure = stylesheetClosure(compile.entry, compile.styleTargets);
  const uses = options.styleGraph.tailwindModules.filter((use) => closure.has(use.stylesheet));
  if (uses.length === 0) {
    return compileTailwind(compile, { tailwind: await loadTailwind(), loadModule: unrecordedTailwindModule });
  }
  if (options.tailwindIsolate === undefined) {
    throw new Error(
      `[pletivo-workers] ${JSON.stringify(compile.entry)} loads Tailwind @plugin or @config modules, ` +
        "which compile only in a Worker Loader isolate, and pageStylesheet() was given none",
    );
  }
  const modules = uses.map((use): TailwindModuleSource => {
    const source = sourceFor(use.module, options.files);
    if (source === undefined) {
      throw new Error(`[pletivo-workers] the bundled Tailwind module ${JSON.stringify(use.module)} has no source`);
    }
    return { ...use, source };
  });
  // The compile walk refuses a rule as `missing` when the artifact has no Tailwind module.
  const tailwind = sourceFor(TAILWIND_RUNTIME_MODULE_ID, options.files);
  if (tailwind === undefined) {
    throw new Error(`[pletivo-workers] the artifact's Tailwind module ${JSON.stringify(TAILWIND_RUNTIME_MODULE_ID)} has no source`);
  }
  return compileTailwindInIsolate(compile, isolateStylesheets(closure, compile), tailwind, modules, options.tailwindIsolate);
}

/** The host's own `tailwindcss`. */
async function loadTailwind(): Promise<TailwindModule> {
  return tailwindModule(await import("tailwindcss"));
}

/** The compile walk records every rule of the closure, so Tailwind reached this one through `@reference`. */
async function unrecordedTailwindModule(specifier: string, stylesheet: ModuleId, hint: "plugin" | "config"): Promise<never> {
  throw new Error(unreachableTailwindModule(hint, specifier, stylesheet));
}

/** The entry and every stylesheet its `@import`s reach. */
function stylesheetClosure(entry: ModuleId, styleTargets: ReadonlyMap<ModuleId, readonly ModuleId[]>): Set<ModuleId> {
  const closure = new Set<ModuleId>([entry]);
  const queue = [entry];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    for (const target of styleTargets.get(next) ?? []) {
      if (closure.has(target)) continue;
      closure.add(target);
      queue.push(target);
    }
  }
  return closure;
}

/**
 * What the isolate can load, by `ProjectFiles` key: the closure, plus every other
 * stylesheet in the map for a `@reference` with no recorded edge. Tailwind's own
 * stylesheets travel separately.
 */
function isolateStylesheets(closure: ReadonlySet<ModuleId>, compile: CompileTailwindOptions): Map<string, string> {
  const files = new Map<string, string>();
  for (const moduleId of closure) {
    if (compile.embeddedTargets.has(moduleId)) continue;
    const source = sourceFor(moduleId, compile.files);
    if (source !== undefined) files.set(fileKeyFor(moduleId), source);
  }
  for (const key of compile.files.keys()) {
    if (!key.endsWith(".css") || files.has(key)) continue;
    const source = compile.files.get(key);
    if (source !== undefined) files.set(key, source);
  }
  return files;
}

export interface StylesheetSource {
  moduleId: ModuleId;
  content: string;
}

/**
 * The stylesheets `entry` reaches, depth first, each importer's targets in source order: a CSS import
 * before a component import comes before that component's CSS, as `pletivo build` walks the graph.
 */
function orderedStylesheets(entry: ModuleId, graph: ResolvedStyleGraph): ModuleId[] {
  const imports = adjacency(graph.edges);
  const stylesheets = new Set(edgesOfKind(graph, "style").map((edge) => edge.target));
  const ordered: ModuleId[] = [];
  const seen = new Set<ModuleId>();
  const visit = (moduleId: ModuleId): void => {
    if (seen.has(moduleId)) return;
    seen.add(moduleId);
    for (const target of imports.get(moduleId) ?? []) visit(target);
    if (stylesheets.has(moduleId)) ordered.push(moduleId);
  };
  visit(entry);
  return ordered;
}

function isUnsupportedProjectCssModule(moduleId: ModuleId): boolean {
  return moduleId.startsWith("project:") && moduleId.endsWith(CSS_MODULE);
}

function embeddedTargets(
  graph: ResolvedStyleGraph,
  files: ProjectFiles,
  stylesheets: TailwindStylesheets,
): ReadonlyMap<ModuleId, keyof TailwindStylesheets> {
  const embedded = new Map<ModuleId, keyof TailwindStylesheets>();
  const entries = Object.entries(stylesheets);
  for (const edge of edgesOfKind(graph, "style")) {
    const source = sourceFor(edge.target, files);
    if (source === undefined) continue;
    for (const [specifier, content] of entries) {
      if (source === content && isTailwindStylesheetSpecifier(specifier)) embedded.set(edge.target, specifier);
    }
  }
  return embedded;
}

type EmitOptions = Pick<PageStylesheetOptions, "srcDir" | "rootDir" | "readBytes" | "islandStylesheets" | "assetsInlineLimit">;

function emitStylesheets(
  stylesheets: readonly StylesheetSource[],
  options: EmitOptions,
  emitted: Map<string, CssAssetLink>,
): string {
  return stylesheets
    .map((stylesheet) => `/* ${labelFor(stylesheet.moduleId, options)} */\n${stylesheetText(stylesheet, options, emitted)}`)
    .join("\n\n");
}

/**
 * What `pletivo build` emits for one stylesheet. It bundles one outside `srcDir`, or a
 * compiled component's, through Bun: the `@import`s are resolved, here already emitted as
 * graph nodes, and the relative `url()`s rewritten. One under `srcDir` it emits as written.
 */
function stylesheetText(stylesheet: StylesheetSource, options: EmitOptions, emitted: Map<string, CssAssetLink>): string {
  const { moduleId, content } = stylesheet;
  if (!moduleId.startsWith("project:")) return withoutCssImports(content);
  const file = moduleId.slice("project:".length);
  if (!options.islandStylesheets.has(moduleId) && file.startsWith(withSlash(options.srcDir))) return content;
  return rewriteCssAssets(file, withoutCssImports(content), options.readBytes, emitted, options.assetsInlineLimit);
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

export function findTailwindEntry(sources: readonly StylesheetSource[]): StylesheetSource | null {
  const ranked = [...sources].sort((left, right) => {
    const leftRank = PREFERRED_ENTRIES.indexOf(basename(left.moduleId));
    const rightRank = PREFERRED_ENTRIES.indexOf(basename(right.moduleId));
    if (leftRank !== -1 && rightRank !== -1) return leftRank - rightRank;
    if (leftRank !== -1) return -1;
    if (rightRank !== -1) return 1;
    return left.moduleId < right.moduleId ? -1 : left.moduleId > right.moduleId ? 1 : 0;
  });
  return ranked.find((source) => cssImports(source.content).includes("tailwindcss")) ?? null;
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
