import path from "path";
import { existsSync } from "fs";
import fs from "fs/promises";
import type { BunPlugin } from "bun";
import { cssAssetBunPlugin, rewriteConfiguredCssAssetUrls, stripCssAssetPlaceholders } from "./css-assets";

type BuildCssOutput = {
  path: string;
  type?: string;
  text: () => Promise<string>;
  arrayBuffer: () => Promise<ArrayBuffer>;
};

interface CssImportEntry {
  sourceFile: string;
  specifiers: string[];
}

interface CssImportGroups {
  source: string[];
  external: string[];
}

interface CollectCssOptions {
  /**
   * `false` switches to *detached* collection: the imports are flattened
   * onto the key instead of becoming a node in the page module graph, and
   * external CSS is dropped because the caller bundles it itself.
   *
   * Used for hoisted `<script>` blocks, whose `sourceFile` is the .astro
   * component but whose code is the script body — attaching them would
   * overwrite the component's own graph node.
   */
  bundleExternalCss?: boolean;
}

type CssRefKind = "external" | "source";

/**
 * One entry of a module's import list, in source order. Keeping CSS and
 * module edges interleaved is what lets the group walk emit rules in
 * import order (spec item 4) rather than "all deps, then all CSS".
 * `dynamic` marks an `import()` edge; a cached page does not load what it reaches.
 */
type NodeItem =
  | { type: "css"; file: string; kind: CssRefKind; dynamic: boolean }
  | { type: "dep"; file: string; dynamic: boolean };

/** A module's import, as the scanner reports it. */
interface ModuleImport {
  specifier: string;
  dynamic: boolean;
}

interface GraphNode {
  items: NodeItem[];
  /**
   * True when the items came from the module's real (compiled) code via
   * `collectCssSideEffectImports`. Speculative nodes derived by re-reading
   * a dependency's source must never overwrite one.
   */
  authoritative: boolean;
}

export interface CssGroup {
  /** Filename fragment derived from the group's first page. */
  name: string;
  css: string;
  /** Absolute paths of the page entries that must link this group. */
  pages: string[];
}

export interface CssPlan {
  /** CSS every page links: unattributed modules plus hoisted-script CSS. */
  shared: string;
  groups: CssGroup[];
  /**
   * Page entries whose module graph was collected this build. A page
   * outside this set (cached, or never imported) has no known CSS reach,
   * so callers must fall back to linking every group.
   */
  knownPages: Set<string>;
}

export interface PlanCssOptions {
  /**
   * Source CSS files already emitted by the main pipeline (the Tailwind
   * entry and its `@import` graph, or every `src/**\/*.css` in concat
   * mode). Re-emitting them raw ships `@import "tailwindcss"` / `@theme`
   * to the browser and — being last and unlayered — outranks the
   * compiled copy.
   */
  consumedSourceCss?: Set<string>;
}

const bundledCssMap = new Map<string, string>();
/** Module graph, keyed by absolute module path. */
const fileNodes = new Map<string, GraphNode>();
/** Collection key → the module file it recorded, for prefix clearing. */
const keyToFile = new Map<string, string>();
/** Detached (hoisted-script) source CSS refs, keyed by collection key. */
const detachedSourceCss = new Map<string, string[]>();
const pageEntryFiles = new Set<string>();
const externalCssText = new Map<string, Promise<string>>();
const cssImportEntries = new Map<string, CssImportEntry>();
const moduleImportCache = new Map<string, Promise<ModuleImport[]>>();
/**
 * Stylesheets that exist only in memory, by absolute path: a compiled component's `<style>`,
 * at a path beside the component so its relative `url()` and `@import` resolve from there,
 * as Vite serves it. Always bundled as external CSS: nothing else processes them.
 */
const virtualCss = new Map<string, string>();

const CSS_IMPORT_PREFIX = "pletivo:css-import:";
const tsTranspiler = new Bun.Transpiler({ loader: "ts" });
const tsxTranspiler = new Bun.Transpiler({ loader: "tsx" });
const jsTranspiler = new Bun.Transpiler({ loader: "js" });
const jsxTranspiler = new Bun.Transpiler({ loader: "jsx" });

let projectRoot: string | null = null;
let sourceCssRoot: string | null = null;

export function configureJsImportedCss(rootDir: string, srcDir: string): void {
  projectRoot = path.resolve(rootDir);
  sourceCssRoot = path.resolve(rootDir, srcDir);
}

/**
 * Mark an absolute page module path as a top-level entry of the CSS
 * module graph. Grouping is by *set of page entries that reach a CSS
 * module*, so a page that is never registered (or never imported, e.g.
 * restored from the incremental cache) is treated as reaching everything.
 */
export function registerCssPageEntry(file: string): void {
  pageEntryFiles.add(path.resolve(file));
}

/** All collected CSS in one string — dev server and tests. */
export async function getJsImportedCssOutput(options: PlanCssOptions = {}): Promise<string> {
  const plan = await planJsImportedCss(options);
  return [plan.shared, ...plan.groups.map((g) => g.css)].filter(Boolean).join("\n\n");
}

/** The CSS the page entries reach, from one merged walk over the pages in path order. */
interface PageCssWalk {
  knownPages: string[];
  /** First position at which any page reaches the module: the deterministic emission order. */
  order: Map<string, number>;
  kinds: Map<string, CssRefKind>;
  pagesFor: Map<string, Set<string>>;
}

function walkPageCss(): PageCssWalk {
  const knownPages = [...pageEntryFiles].filter((file) => fileNodes.has(file)).sort();

  // Walk each page entry. `order` doubles as the set of attributed CSS
  // modules and as the deterministic emission order: a module is indexed
  // the first time any page reaches it, which is exactly the position a
  // single merged post-order walk over the sorted pages would give it.
  const order = new Map<string, number>();
  const kinds = new Map<string, CssRefKind>();
  const pagesFor = new Map<string, Set<string>>();
  for (const page of knownPages) {
    walkCssGraph(page, new Set<string>(), (file, kind) => {
      if (!order.has(file)) {
        order.set(file, order.size);
        kinds.set(file, kind);
      }
      let pages = pagesFor.get(file);
      if (!pages) pagesFor.set(file, (pages = new Set<string>()));
      pages.add(page);
    });
  }
  return { knownPages, order, kinds, pagesFor };
}

/**
 * Absolute stylesheet paths in the order the page modules import them: the merged walk
 * `planJsImportedCss` orders its groups by. Files no page reaches keep their given order,
 * ahead of the rest.
 */
export function inImportOrder(files: readonly string[]): string[] {
  const { order } = walkPageCss();
  const unreached = files.filter((file) => !order.has(file));
  const reached = files.filter((file) => order.has(file));
  reached.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  return [...unreached, ...reached];
}

export async function planJsImportedCss(options: PlanCssOptions = {}): Promise<CssPlan> {
  const consumed = options.consumedSourceCss ?? new Set<string>();
  const { knownPages, order, kinds, pagesFor } = walkPageCss();

  // Anything the page walk did not reach still has to ship. Rather than
  // guess, it goes in the shared sheet — the pre-grouping behaviour.
  const shared = new Set<string>();
  for (const node of fileNodes.values()) {
    for (const item of node.items) {
      if (item.type !== "css" || order.has(item.file)) continue;
      shared.add(item.file);
      kinds.set(item.file, item.kind);
    }
  }
  // Hoisted-script CSS is page-agnostic here: the scripts are bundled as
  // one artifact, so their source CSS cannot be attributed to a page set.
  for (const files of detachedSourceCss.values()) {
    for (const file of files) {
      shared.add(file);
      kinds.set(file, "source");
      order.delete(file);
      pagesFor.delete(file);
    }
  }

  const text = async (file: string): Promise<string> =>
    kinds.get(file) === "source"
      ? await sourceCssText(file, consumed)
      : await externalCssBundle(file);

  const sharedParts: string[] = [];
  for (const file of [...shared].sort()) {
    const css = await text(file);
    if (css) sharedParts.push(css);
  }
  for (const css of sortedByKey(bundledCssMap)) {
    if (css) sharedParts.push(css);
  }

  const buckets = new Map<string, string[]>();
  for (const file of order.keys()) {
    const pages = pagesFor.get(file);
    if (!pages) continue;
    const signature = [...pages].sort().join("\n");
    const bucket = buckets.get(signature);
    if (bucket) bucket.push(file);
    else buckets.set(signature, [file]);
  }

  const ranked: Array<{ rank: number; group: CssGroup }> = [];
  for (const [signature, files] of buckets) {
    files.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    const parts: string[] = [];
    for (const file of files) {
      const css = await text(file);
      if (css) parts.push(css);
    }
    if (parts.length === 0) continue;
    const pages = signature.split("\n");
    ranked.push({
      rank: order.get(files[0]) ?? 0,
      group: { name: groupName(pages), css: parts.join("\n\n"), pages },
    });
  }
  // Link order follows the same merged walk the single bundle used, so a
  // group whose rules came first still comes first.
  ranked.sort((a, b) => a.rank - b.rank);

  return {
    shared: sharedParts.join("\n\n"),
    groups: ranked.map((entry) => entry.group),
    knownPages: new Set(knownPages),
  };
}

/** One import of a graph module, as the incremental cache keeps it. */
export interface GraphNodeItem {
  type: "css" | "dep";
  file: string;
  dynamic: boolean;
}

/** A graph module as the incremental cache keeps it: its imports in source order. */
export interface GraphNodeRecord {
  file: string;
  items: GraphNodeItem[];
}

/** What `dynamicGraphOf` records: the modules, and the text of their in-memory stylesheets. */
export interface DynamicGraph {
  nodes: GraphNodeRecord[];
  virtualCss: Array<{ file: string; css: string }>;
}

/**
 * The graph modules reached from `page` and its `deps` but not through the page's static
 * imports. A page restored from the incremental cache is not rendered, so those modules do
 * not load; `restoreDynamicGraph` puts them back so the page walk equals a full build's.
 */
export function dynamicGraphOf(page: string, deps: Iterable<string>): DynamicGraph {
  const entry = path.resolve(page);
  const staticModules = new Set<string>();
  walkCssGraph(entry, staticModules, () => {}, true);
  const reached = new Set<string>();
  walkCssGraph(entry, reached, () => {});
  for (const dep of deps) walkCssGraph(dep, reached, () => {});
  const nodes: GraphNodeRecord[] = [];
  const texts = new Map<string, string>();
  for (const file of [...reached].sort()) {
    const node = fileNodes.get(file);
    if (!node || staticModules.has(file)) continue;
    nodes.push({ file, items: node.items.map((item) => ({ type: item.type, file: item.file, dynamic: item.dynamic })) });
    for (const item of node.items) {
      const css = item.type === "css" ? virtualCss.get(item.file) : undefined;
      if (css !== undefined) texts.set(item.file, css);
    }
  }
  return { nodes, virtualCss: [...texts].map(([file, css]) => ({ file, css })) };
}

/**
 * Put back the modules `dynamicGraphOf` recorded for a page that is not rendered this build,
 * where no module loaded this build. `storedCss` gives the recorded text of an in-memory stylesheet.
 */
export function restoreDynamicGraph(
  nodes: readonly GraphNodeRecord[],
  storedCss: (file: string) => string | undefined,
): void {
  for (const node of nodes) {
    if (fileNodes.get(node.file)?.authoritative) continue;
    const items: NodeItem[] = [];
    for (const item of node.items) {
      if (item.type === "dep") {
        items.push({ type: "dep", file: item.file, dynamic: item.dynamic });
        continue;
      }
      const css = storedCss(item.file);
      if (css === undefined) {
        // Deleted since, through an edge the dependency graph does not see: nothing left to ship.
        if (!virtualCss.has(item.file) && !existsSync(item.file)) continue;
      } else if (!virtualCss.has(item.file)) {
        // A component compiled this build has the current text already.
        setVirtualCss(item.file, css);
      }
      items.push({ type: "css", file: item.file, kind: cssKind(item.file), dynamic: item.dynamic });
    }
    fileNodes.set(node.file, { items, authoritative: true });
  }
}

/** Emit the CSS reachable from `file` in import order. `staticOnly` skips `import()` edges. */
function walkCssGraph(
  file: string,
  visited: Set<string>,
  emit: (file: string, kind: CssRefKind) => void,
  staticOnly = false,
): void {
  if (visited.has(file)) return;
  visited.add(file);
  const node = fileNodes.get(file);
  if (!node) return;
  for (const item of node.items) {
    if (staticOnly && item.dynamic) continue;
    if (item.type === "dep") walkCssGraph(item.file, visited, emit, staticOnly);
    else emit(item.file, item.kind);
  }
}

function groupName(pages: string[]): string {
  const named = pages.find((page) => {
    const base = path.basename(page, path.extname(page));
    return base !== "404" && base !== "500";
  });
  return prettyName(named ?? pages[0] ?? "chunk");
}

function prettyName(file: string): string {
  let base = path.basename(file, path.extname(file));
  if (base === "index" || base === "") base = path.basename(path.dirname(file));
  base = base.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return base.slice(0, 24) || "chunk";
}

function sortedByKey(map: Map<string, string>): string[] {
  return [...map.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, value]) => value);
}

/**
 * Register (or replace) an in-memory stylesheet. A module that imports `file` in the code
 * passed to `collectCssSideEffectImports` links it like a CSS file on disk.
 */
export function setVirtualCss(file: string, css: string): void {
  const resolved = path.resolve(file);
  if (virtualCss.get(resolved) === css) return;
  virtualCss.set(resolved, css);
  externalCssText.delete(resolved);
}

export function clearJsImportedCss(): void {
  virtualCss.clear();
  fileNodes.clear();
  keyToFile.clear();
  detachedSourceCss.clear();
  pageEntryFiles.clear();
  externalCssText.clear();
  bundledCssMap.clear();
  cssImportEntries.clear();
  moduleImportCache.clear();
}

export function clearJsImportedCssImportCache(): void {
  moduleImportCache.clear();
}

export function clearCollectedCss(prefix: string): void {
  for (const [key, file] of keyToFile) {
    if (!key.startsWith(prefix)) continue;
    keyToFile.delete(key);
    fileNodes.delete(file);
  }
  for (const key of detachedSourceCss.keys()) {
    if (key.startsWith(prefix)) detachedSourceCss.delete(key);
  }
  clearBundledCss(prefix);
}

export function clearBundledCss(prefix: string): void {
  for (const key of bundledCssMap.keys()) {
    if (key.startsWith(prefix)) bundledCssMap.delete(key);
  }
}

export async function recordBuildCssOutputs(
  outputs: BuildCssOutput[],
  key: string,
): Promise<void> {
  const css: string[] = [];
  for (const output of outputs) {
    if (!isCssOutput(output)) continue;
    css.push(stripCssAssetPlaceholders(await output.text()));
  }

  if (css.length > 0) {
    bundledCssMap.set(key, css.join("\n\n"));
  } else {
    bundledCssMap.delete(key);
  }
}

export function jsOutputFromBuild(outputs: BuildCssOutput[]): BuildCssOutput | undefined {
  return outputs.find(isJsOutput);
}

// Page modules that are NOT `.astro` (`.tsx`/`.ts`/`.mdx`/…) don't pass
// through the astro plugin's onLoad, so their CSS side-effect imports aren't
// collected there. Read the source and collect from it directly. `.astro` and
// `.md` are skipped: their loaders collect from the compiled module.
const PAGE_MODULE_CSS_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mdx",
]);

export async function collectPageModuleCss(file: string, key: string): Promise<void> {
  if (!PAGE_MODULE_CSS_EXTENSIONS.has(path.extname(file).toLowerCase())) return;
  const code = await readTextFile(file);
  if (code === null) return;
  await collectCssSideEffectImports(file, code, key);
}

export async function collectCssSideEffectImports(
  sourceFile: string,
  code: string,
  key: string,
  options: CollectCssOptions = {},
): Promise<void> {
  if (options.bundleExternalCss === false) {
    // Detached: flatten onto the key, don't touch the module graph.
    const imports = await collectCssImports(sourceFile, code);
    if (imports.source.length > 0) detachedSourceCss.set(key, imports.source);
    else detachedSourceCss.delete(key);
    return;
  }

  const file = path.resolve(sourceFile);
  keyToFile.set(key, file);
  fileNodes.set(file, {
    items: nodeItems(file, moduleImportsFromCode(file, code)),
    authoritative: true,
  });
  await expandGraph(file, new Set<string>([file]));
}

/**
 * Fill in graph nodes for everything reachable from `file`. Nodes recorded
 * by `collectCssSideEffectImports` are authoritative and left alone —
 * re-deriving a `.astro` node from its raw source would lose the imports
 * that only exist in the compiled output.
 */
async function expandGraph(file: string, visited: Set<string>): Promise<void> {
  const node = fileNodes.get(file);
  if (!node) return;
  for (const item of node.items) {
    if (item.type !== "dep") continue;
    const dep = item.file;
    if (visited.has(dep)) continue;
    visited.add(dep);
    const existing = fileNodes.get(dep);
    if (!existing?.authoritative) {
      fileNodes.set(dep, {
        items: nodeItems(dep, await moduleImportsForFile(dep)),
        authoritative: false,
      });
    }
    await expandGraph(dep, visited);
  }
}

function nodeItems(sourceFile: string, imports: ModuleImport[]): NodeItem[] {
  const items: NodeItem[] = [];
  const seen = new Map<string, NodeItem>();
  const add = (key: string, item: NodeItem): void => {
    const existing = seen.get(key);
    // Imported both ways, in either order: the static import always loads it.
    if (existing) existing.dynamic = existing.dynamic && item.dynamic;
    else {
      seen.set(key, item);
      items.push(item);
    }
  };
  for (const { specifier, dynamic } of imports) {
    const clean = stripQuery(specifier);
    if (!clean || isVirtualOrBuiltin(clean)) continue;

    const cssPath = resolveCssSpecifier(sourceFile, specifier);
    if (cssPath) {
      add(`css\0${cssPath}`, { type: "css", file: cssPath, kind: cssKind(cssPath), dynamic });
      continue;
    }

    const modulePath = resolveLocalModule(specifier, sourceFile);
    if (modulePath) add(`dep\0${modulePath}`, { type: "dep", file: modulePath, dynamic });
  }
  return items;
}

/**
 * Bundle one CSS module — `@import`s resolved, `url()` assets handled by
 * Bun. Memoized per file: the same stylesheet reached from 39 pages is
 * built once and its text emitted once.
 */
async function externalCssBundle(file: string): Promise<string> {
  let pending = externalCssText.get(file);
  if (!pending) {
    pending = buildExternalCss(file);
    externalCssText.set(file, pending);
  }
  return await pending;
}

async function buildExternalCss(file: string): Promise<string> {
  const token = Bun.hash(file).toString(16).padStart(16, "0");
  cssImportEntries.set(token, { sourceFile: file, specifiers: [file] });
  try {
    const result = await Bun.build({
      entrypoints: [CSS_IMPORT_PREFIX + token],
      format: "esm",
      target: "browser",
      minify: false,
      // The virtual stylesheets first: the side-effect plugin would empty one that sits under srcDir.
      plugins: [virtualCssBunPlugin(), cssSideEffectBunPlugin(), cssImportBunPlugin(), cssAssetBunPlugin()],
    });

    if (!result.success) {
      const logs = result.logs.map((log) => String(log)).join("\n");
      console.error(`[pletivo] CSS side-effect import collection failed for ${file}:\n${logs}`);
      return "";
    }

    const css: string[] = [];
    for (const output of result.outputs) {
      if (!isCssOutput(output)) continue;
      css.push(stripCssAssetPlaceholders(await output.text()));
    }
    return css.join("\n\n");
  } finally {
    cssImportEntries.delete(token);
  }
}

async function sourceCssText(file: string, consumed: Set<string>): Promise<string> {
  if (consumed.has(file)) return "";
  const content = await readTextFile(file);
  if (content === null) return "";
  const label = projectRoot ? path.relative(projectRoot, file) : file;
  return `/* ${label} */\n${content}`;
}

export function cssSideEffectBunPlugin(): BunPlugin {
  return {
    name: "pletivo-css-side-effects",
    setup(build) {
      build.onLoad({ filter: /\.css(\?.*)?$/ }, async (args) => {
        const cleanPath = stripQuery(args.path);
        if (/\.module\.css$/i.test(cleanPath)) return undefined;
        if (!isSourceCss(cleanPath)) return undefined;
        return { contents: "", loader: "css" };
      });
    },
  };
}

/** Serves the in-memory stylesheets to the external CSS bundle, at their paths beside the component. */
function virtualCssBunPlugin(): BunPlugin {
  return {
    name: "pletivo-virtual-css",
    setup(build) {
      build.onResolve({ filter: /\.css$/ }, (args) => {
        const file = path.isAbsolute(args.path) ? args.path : path.resolve(path.dirname(args.importer), args.path);
        return virtualCss.has(file) ? { path: file } : undefined;
      });
      build.onLoad({ filter: /\.css$/ }, async (args) => {
        const css = virtualCss.get(args.path);
        if (css === undefined) return undefined;
        return { contents: await rewriteConfiguredCssAssetUrls(args.path, css), loader: "css" };
      });
    },
  };
}

function cssImportBunPlugin(): BunPlugin {
  const resolveFilter = new RegExp(`^${CSS_IMPORT_PREFIX}[a-f0-9]+$`);
  const loadFilter = /\/[a-f0-9]{16}\.js$/;

  return {
    name: "pletivo-css-imports",
    setup(build) {
      build.onResolve({ filter: resolveFilter }, (args) => {
        const token = args.path.slice(CSS_IMPORT_PREFIX.length);
        const entry = cssImportEntries.get(token);
        if (!entry) return undefined;
        return {
          path: path.join(path.dirname(entry.sourceFile), `${token}.js`),
        };
      });

      build.onLoad({ filter: loadFilter }, (args) => {
        const match = args.path.match(/\/([a-f0-9]{16})\.js$/);
        if (!match) return undefined;
        const entry = cssImportEntries.get(match[1]);
        if (!entry) return undefined;
        return {
          contents: entry.specifiers
            .map((specifier) => `import ${JSON.stringify(specifier)};`)
            .join("\n"),
          loader: "js",
        };
      });
    },
  };
}

function extractCssSideEffectImports(sourceFile: string, code: string): string[] {
  const specifiers: string[] = [];
  const re = /(?:^|[;\n\r])\s*import\s+["']([^"']+)["']\s*;?/g;
  let match;
  while ((match = re.exec(code)) !== null) {
    const specifier = match[1];
    if (isCssSpecifier(sourceFile, specifier)) specifiers.push(specifier);
  }
  return specifiers;
}

async function collectCssImports(sourceFile: string, code: string): Promise<CssImportGroups> {
  const out = { source: new Set<string>(), external: new Set<string>() };
  await collectCssSpecifiersFromImports(
    sourceFile,
    staticSpecifiers(moduleImportsFromCode(sourceFile, code)),
    out,
    new Set<string>(),
  );
  return {
    source: [...out.source].sort(),
    external: [...out.external].sort(),
  };
}

async function collectCssSpecifiersFromImports(
  sourceFile: string,
  imports: string[],
  out: { source: Set<string>; external: Set<string> },
  visited: Set<string>,
): Promise<void> {
  for (const specifier of imports) {
    const clean = stripQuery(specifier);
    if (!clean || isVirtualOrBuiltin(clean)) continue;

    const cssPath = resolveCssSpecifier(sourceFile, specifier);
    if (cssPath) {
      if (cssKind(cssPath) === "source") {
        out.source.add(cssPath);
      } else {
        out.external.add(cssPath);
      }
      continue;
    }

    const modulePath = resolveLocalModule(specifier, sourceFile);
    if (!modulePath || visited.has(modulePath)) continue;
    visited.add(modulePath);
    await collectCssSpecifiersFromImports(
      modulePath,
      staticSpecifiers(await moduleImportsForFile(modulePath)),
      out,
      visited,
    );
  }
}

async function moduleImportsForFile(file: string): Promise<ModuleImport[]> {
  let promise = moduleImportCache.get(file);
  if (!promise) {
    promise = readModuleImportsForFile(file);
    moduleImportCache.set(file, promise);
  }
  return await promise;
}

async function readModuleImportsForFile(file: string): Promise<ModuleImport[]> {
  const code = await readTextFile(file);
  if (code === null) return [];
  return moduleImportsFromCode(file, code);
}

function staticSpecifiers(imports: ModuleImport[]): string[] {
  return imports.filter((entry) => !entry.dynamic).map((entry) => entry.specifier);
}

async function readTextFile(file: string): Promise<string | null> {
  const virtual = virtualCss.get(file);
  if (virtual !== undefined) return virtual;
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

/** Static imports and `import()` calls with a string specifier; a computed one is not reported. */
function moduleImportsFromCode(sourceFile: string, code: string): ModuleImport[] {
  try {
    const imports: ModuleImport[] = [];
    for (const entry of pickTranspiler(path.extname(sourceFile).toLowerCase()).scanImports(code)) {
      if (entry.kind === "import-statement") imports.push({ specifier: entry.path, dynamic: false });
      else if (entry.kind === "dynamic-import") imports.push({ specifier: entry.path, dynamic: true });
    }
    return imports;
  } catch {
    return extractCssSideEffectImports(sourceFile, code).map((specifier) => ({ specifier, dynamic: false }));
  }
}

function pickTranspiler(ext: string): Bun.Transpiler {
  if (ext === ".tsx" || ext === ".astro" || ext === ".mdx") return tsxTranspiler;
  if (ext === ".jsx") return jsxTranspiler;
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return jsTranspiler;
  return tsTranspiler;
}

function resolveCssSpecifier(sourceFile: string, specifier: string): string | null {
  const clean = stripQuery(specifier);
  if (/\.module\.css$/i.test(clean)) return null;
  if (!isCssSpecifier(sourceFile, specifier)) return null;
  // The bare-specifier heuristic in isCssSpecifier() can match JS packages
  // whose name/subpath merely contains "css" (e.g. `@emotion/css`). Only
  // treat the import as CSS if it actually resolves to a .css file.
  const resolved = resolveSpecifier(clean, sourceFile, [".css"]);
  if (!resolved || !/\.css$/i.test(resolved)) return null;
  return resolved;
}

function resolveLocalModule(specifier: string, sourceFile: string): string | null {
  const clean = stripQuery(specifier);
  if (!clean.startsWith(".") && !clean.startsWith("/")) return null;
  const resolved = resolveSpecifier(clean, sourceFile, [
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
  ]);
  if (!resolved) return null;
  if (!projectRoot) return resolved;
  const rel = path.relative(projectRoot, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return resolved;
}

function resolveSpecifier(
  specifier: string,
  sourceFile: string,
  extensions: string[],
): string | null {
  let candidate: string;
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    candidate = path.isAbsolute(specifier)
      ? specifier
      : path.resolve(path.dirname(sourceFile), specifier);
  } else {
    try {
      candidate = Bun.resolveSync(specifier, path.dirname(sourceFile));
    } catch {
      try {
        candidate = require.resolve(specifier, {
          paths: [path.dirname(sourceFile), process.cwd()],
        });
      } catch {
        return null;
      }
    }
  }

  if (path.extname(candidate) && fileExistsSync(candidate)) return candidate;
  for (const ext of extensions) {
    if (fileExistsSync(candidate + ext)) return candidate + ext;
  }
  for (const ext of extensions) {
    const indexPath = path.join(candidate, `index${ext}`);
    if (fileExistsSync(indexPath)) return indexPath;
  }
  return null;
}

function fileExistsSync(file: string): boolean {
  return virtualCss.has(file) || existsSync(file);
}

function isCssSpecifier(sourceFile: string, specifier: string): boolean {
  const clean = specifier.split(/[?#]/, 1)[0];
  if (/\.module\.css$/i.test(clean)) return false;
  if (/\.(scss|sass)$/i.test(clean)) return false;
  if (/\.css$/i.test(clean)) return true;

  try {
    const resolved = require.resolve(specifier, {
      paths: [path.dirname(sourceFile), process.cwd()],
    });
    if (/\.css$/i.test(resolved)) return true;
  } catch {
    // Fall back to common package export names such as `swiper/css`.
  }

  return /(^|\/)css(\/|$)/i.test(clean);
}

function cssKind(file: string): CssRefKind {
  return isSourceCss(file) && !virtualCss.has(file) ? "source" : "external";
}

function isSourceCss(file: string): boolean {
  if (!sourceCssRoot) return false;
  const rel = path.relative(sourceCssRoot, file);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function isVirtualOrBuiltin(specifier: string): boolean {
  if (specifier.startsWith("node:") || specifier.startsWith("bun:")) return true;
  return /^[a-z][a-z0-9-]*:/.test(specifier) && !path.isAbsolute(specifier);
}

function stripQuery(p: string): string {
  const q = p.indexOf("?");
  return q === -1 ? p : p.slice(0, q);
}

function isCssOutput(output: BuildCssOutput): boolean {
  return output.type?.includes("text/css") === true || output.path.endsWith(".css");
}

function isJsOutput(output: BuildCssOutput): boolean {
  return output.type?.includes("javascript") === true || output.path.endsWith(".js");
}
