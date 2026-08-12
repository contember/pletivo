/**
 * Cascade order for the `<style>` blocks hoisted out of `.astro` files.
 *
 * The order those blocks are concatenated in decides the cascade, so it
 * decides what the page looks like — it is not a free choice. The order a
 * site's CSS is written against is the one Astro emits, and Astro's comes
 * from Vite/Rollup: a page's CSS is its module graph's style imports in
 * module-execution order. Checked against Astro 5.18's own output:
 *
 *   - a page's own `<style>` lands *after* the CSS of the components it
 *     imports, so the page wins ties against the layout it renders inside;
 *   - siblings follow the importer's *import* order, not the order they are
 *     rendered in — importing B then A and rendering A then B emits B first;
 *   - a deeper component precedes the component that imports it;
 *   - a module reached through two parents keeps its first position.
 *
 * That is a depth-first post-order walk of the static import graph rooted at
 * the page module, visiting each module's imports in source order. This module
 * records the graph and answers that walk.
 *
 * Cost is paid only where it buys something: `.astro` modules hand over their
 * specifiers while the loader already holds the compiled source, everything
 * else is read lazily, and a page with fewer than two CSS-contributing
 * components never walks at all.
 *
 * Related but different from `incremental/import-graph.ts`: that one answers
 * "which files feed this page" (a set, for cache invalidation), this one
 * answers "in which order do they execute" (a sequence, for the cascade).
 */

import path from "path";
import { fileURLToPath } from "url";
import { getDevVersion, stripQuery } from "@pletivo/core/dev-cache";

type ScanLoader = "ts" | "tsx" | "js" | "jsx";

/** Extensions the walk can follow through. */
const LOADERS: Record<string, ScanLoader> = {
  ".ts": "ts",
  ".tsx": "tsx",
  ".js": "js",
  ".jsx": "jsx",
  ".mjs": "js",
  ".cjs": "js",
};

const transpilers = new Map<ScanLoader, Bun.Transpiler>();

/** Import specifiers per module, in execution order. */
const specifiers = new Map<string, string[]>();
/** Resolved edges per module. */
const edges = new Map<string, Promise<string[]>>();
/** Post-order module ids per page entry. */
const orders = new Map<string, Promise<string[]>>();

/**
 * This package's own source directory. Every compiled `.astro` module imports
 * the runtime shim from here by absolute path; following it would drag the
 * whole runtime into the walk for nothing.
 */
const ownSrcDir = path.dirname(fileURLToPath(import.meta.url));

let graphGeneration = 0;
let memoGeneration = -1;

/**
 * The id a module is known by in the CSS map and in the shim's rendered-module
 * registry: the path the Astro compiler is handed as `filename`.
 */
export function moduleIdFor(file: string): string {
  return path.relative(process.cwd(), file);
}

/**
 * Record a compiled `.astro` module's imports. `code` is the compiler's own
 * output, so the import list it carries is the one Bun will execute.
 */
export function recordAstroImports(file: string, code: string): void {
  const specs = scanImports(code, "ts");
  const previous = specifiers.get(file);
  specifiers.set(file, specs);
  if (!previous || previous.join("\n") !== specs.join("\n")) graphGeneration++;
}

export function clearAstroImportGraph(): void {
  specifiers.clear();
  graphGeneration++;
}

/**
 * Module ids reachable from `entry`, in the order their CSS executes.
 * Modules that contribute no CSS are included — the caller filters.
 */
export async function moduleOrderForEntry(entry: string): Promise<string[]> {
  dropStaleMemos();
  let order = orders.get(entry);
  if (!order) {
    order = walk(entry);
    orders.set(entry, order);
  }
  return await order;
}

/** Editing a file in dev rewrites the graph under the memos. */
function dropStaleMemos(): void {
  const generation = graphGeneration + getDevVersion();
  if (generation === memoGeneration) return;
  memoGeneration = generation;
  edges.clear();
  orders.clear();
}

async function walk(entry: string): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = async (file: string): Promise<void> => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const child of await edgesOf(file)) await visit(child);
    out.push(moduleIdFor(file));
  };
  await visit(entry);
  return out;
}

async function edgesOf(file: string): Promise<string[]> {
  let resolved = edges.get(file);
  if (!resolved) {
    resolved = resolveEdges(file);
    edges.set(file, resolved);
  }
  return await resolved;
}

async function resolveEdges(file: string): Promise<string[]> {
  const specs = specifiers.get(file) ?? (await scanFile(file));
  const fromDir = path.dirname(file);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const spec of specs) {
    const resolved = resolveSpecifier(spec, fromDir);
    // The compiler emits both `import X from './X.astro'` and
    // `import * as $$module1 from './X.astro'` — one edge, not two.
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

/**
 * Read a module the loader never handed us: a `.tsx` page that renders
 * `.astro` components, or a plain module sitting between the two.
 *
 * A `.astro` file with no recorded specifiers never reached the loader, so it
 * holds no CSS and neither can anything it imports — the walk stops there.
 * `.md` / `.mdx` are not scanned; their imports need the markdown pipeline to
 * be visible, and the caller has a fallback for what the walk cannot reach.
 */
async function scanFile(file: string): Promise<string[]> {
  const loader = LOADERS[path.extname(file).toLowerCase()];
  if (!loader) return [];
  try {
    return scanImports(await Bun.file(file).text(), loader);
  } catch {
    return [];
  }
}

function scanImports(source: string, loader: ScanLoader): string[] {
  let transpiler = transpilers.get(loader);
  if (!transpiler) {
    transpiler = new Bun.Transpiler({ loader });
    transpilers.set(loader, transpiler);
  }
  let scanned: { kind: string; path: string }[];
  try {
    scanned = transpiler.scanImports(source);
  } catch {
    return [];
  }
  // Astro orders a module's dynamic imports after all of its static ones
  // (`core/build/graph.ts`); a lazily imported component's CSS lands there too.
  const statics: string[] = [];
  const dynamics: string[] = [];
  for (const { kind, path: spec } of scanned) {
    (kind === "dynamic-import" ? dynamics : statics).push(spec);
  }
  return [...statics, ...dynamics];
}

function resolveSpecifier(spec: string, fromDir: string): string | null {
  // `Foo.astro?astro&type=style|script` are the compiler's own virtual
  // modules; they resolve back to the file that declared them.
  if (spec.includes("?astro&type=")) return null;
  const clean = stripQuery(spec);
  if (!clean) return null;
  // `astro:content`, `node:path`, `pletivo:hoisted:…`
  if (!path.isAbsolute(clean) && /^[a-z][a-z0-9+.-]*:/i.test(clean)) return null;
  try {
    const resolved = Bun.resolveSync(clean, fromDir);
    return walkable(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

function walkable(file: string): boolean {
  const ext = path.extname(file).toLowerCase();
  // A `.astro` file is worth following wherever it lives — packages ship
  // components. Nothing else under node_modules can reach a project component.
  if (ext === ".astro") return true;
  if (!(ext in LOADERS)) return false;
  if (file.includes(`${path.sep}node_modules${path.sep}`)) return false;
  if (file.startsWith(ownSrcDir + path.sep)) return false;
  return true;
}
