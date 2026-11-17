import path from "node:path";
import fs from "node:fs/promises";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const { version: PLETIVO_VERSION } = require_("../../package.json") as { version: string };

/**
 * Bumping this invalidates every existing on-disk cache. Bump when the
 * cache schema shape changes in a way that would corrupt the build if
 * old entries were read by new code.
 */
// Bumped to 4 — added per-route `size` so warm builds can sum sizes
// without stat'ing every cached output file.
// Bumped to 5: added per-route `cssEntry`. A page that rewrote, cached by
// version 4, would keep linking its own CSS groups instead of the target's.
// Bumped to 6: added per-route `astroIslands`. A page cached by version 5
// would leave its framework components out of the island bundles.
// Bumped to 7: added per-route `cssHead`. Inlined stylesheets cannot be
// found in cached HTML by a `<link>` pattern, so the written fragment is kept.
// Bumped to 8: added per-route `dynamicCss` and the cache-level `virtualCss`. A page
// cached by version 7 would drop the CSS of modules its render imported dynamically.
export const CACHE_SCHEMA_VERSION = 8;

/** A framework component export an `<astro-island>` hydrates. */
export interface CachedAstroIsland {
  componentPath: string;
  exportName: string;
}

/** The stylesheet markup `writeHtml` put before `</head>`, so a cached page's can be swapped. */
export interface CachedCssHead {
  /** The exact text inserted; empty when nothing was. */
  fragment: string;
  /** The page's own `.astro`/TSX `<style>` CSS, which an adjacent inlined sheet merges with. */
  pageCss: string;
}

export interface CachedFragmentRef {
  hash: string;
  moduleId: string;
  props: Record<string, unknown>;
}

/**
 * Cheap-to-check identity for a single dep file. `mtime + size` is the
 * fast path — a single stat lets us decide whether a file changed
 * without reading bytes. `hash` is kept as a fallback in case mtime
 * matches but size doesn't, or for tooling that needs content identity
 * across e.g. `touch`-only edits.
 */
export interface DepFingerprint {
  mtimeMs: number;
  size: number;
  hash: string;
}

export interface RouteCacheEntry {
  /** dist-relative output path (e.g. "blog/hello/index.html") */
  outPath: string;
  /** sha hash of the rendered HTML, for cheap unchanged-output detection */
  outputHash: string;
  /**
   * Per-dep fingerprints captured during the last render. Map of
   * absolute paths → `{mtimeMs, size, hash}`. On rebuild we stat each
   * entry and skip the render when every mtime+size still matches.
   * Content hash is consulted only when mtime drifted but the file
   * might actually be unchanged (e.g. a `touch`-only edit).
   */
  depFingerprints: Record<string, DepFingerprint>;
  /**
   * Astro `is:global` CSS attribution depends on which component modules
   * actually rendered on this page. We persist the set so the CSS
   * post-pass can include it when this page is skipped.
   */
  renderedModules: string[];
  /**
   * Literal `<style>` JSX blocks collected during this page's render —
   * the JSX runtime pushes them so build.ts can inline them in <head>.
   * Persisted alongside the cached HTML for the same reason as
   * renderedModules.
   */
  tsxStyles: string[];
  /**
   * Fragment registrations made during this page's render (via
   * @nuasite/astro-fragments). Replayed on the next incremental build
   * when this page is skipped, so the fragments integration sees the
   * full registry and can either reuse cached fragment files or
   * lazy-render newly-changed ones.
   */
  fragments: CachedFragmentRef[];
  /**
   * Island component names referenced from this page's rendered HTML.
   * Cached so the post-render `bundleIslands` pass can be fed the full
   * union without having to re-read every cached page's HTML from disk.
   */
  islands: string[];
  /**
   * Hoisted-script hashes referenced from this page's rendered HTML.
   * Same motivation as `islands` — avoids reading cached HTML purely
   * to scan for `_astro/hoisted-<hash>.js` markers.
   */
  hoistedHashes: string[];
  /**
   * Framework components this page hydrates through Astro's renderers. A
   * cached page is not re-rendered, so the island bundles learn its
   * components from here.
   */
  astroIslands: CachedAstroIsland[];
  /**
   * Page module whose CSS this output links, when it is not the route's own
   * entry (the page `Astro.rewrite`s to another route). Persisted because a
   * cached page is not re-rendered, and the CSS links are re-derived every
   * build. Absent means the route's own entry.
   */
  cssEntry?: string;
  /** Written by `writeHtml`, like `size`; null when the page has no `</head>`, so no stylesheet reaches it. */
  cssHead: CachedCssHead | null;
  /**
   * Stylesheets of modules the render imported dynamically. A cached page is
   * not rendered, so those modules do not load and their CSS is restored from here.
   * One that exists only in memory has its text in `PletivoCache.virtualCss`.
   */
  dynamicCss: string[];
  /**
   * Byte size of the rendered HTML output. Cached so warm builds
   * don't have to stat every cached file just to print the total.
   */
  size: number;
}

/**
 * Cached result of a dynamic route's `getStaticPaths()` call. The slug
 * list (and the per-slug `props` payload) is reused on the next build
 * when none of the captured deps changed — avoids re-executing the
 * function, which for content-collection-backed routes typically reads
 * the entire collection. Single biggest warm-build cost without this
 * cache.
 */
export interface DynamicRouteCacheEntry {
  /**
   * The param sets `getStaticPaths()` produced last build — just the
   * params, not props, so this cache works for every dynamic route,
   * including collection-backed ones whose props carry non-serializable
   * values (`render()` methods, Dates, etc.). JSON drops an `undefined`
   * param (the first page of a `[...page]` route), so compare param sets
   * through `paramsToKey`, which treats it as absent.
   *
   * Props are fetched on demand: when one or more slugs of this route
   * actually need to re-render, the build calls getStaticPaths again
   * to get a fresh path list — but only then. On a fully-cached warm
   * build no getStaticPaths invocation happens at all.
   */
  paramSets: Array<{ params: Record<string, string | undefined> }>;
  /**
   * Fingerprints of every file read during the last
   * `getStaticPaths()` execution (typically the content collection
   * source files). On rebuild we re-fingerprint and only re-run when
   * any has changed.
   */
  depFingerprints: Record<string, DepFingerprint>;
}

/**
 * Every file the last build wrote for its routes, pages and endpoints alike. `dist/`
 * also holds files no route owns (public/, bundles, integration output), so only
 * these may be removed when a later build no longer writes them.
 */
export interface RouteOutputs {
  /** Output directory relative to the project root; `files` are relative to it. */
  outDir: string;
  files: string[];
}

export interface PletivoCache {
  schemaVersion: number;
  pletivoVersion: string;
  configHash: string;
  routes: Record<string, RouteCacheEntry>;
  dynamicRoutes: Record<string, DynamicRouteCacheEntry>;
  /** A compiled framework component's `<style>` text, by its in-memory stylesheet path, once for every route listing it in `dynamicCss`. */
  virtualCss: Record<string, string>;
  /** Kept when the render cache is invalidated: it describes `dist/`, which survives that. */
  routeOutputs: RouteOutputs | null;
}

/** Present while a build writes `dist/`; `persist()` removes it. */
const WRITING_MARKER = "writing";

/**
 * On-disk cache backing pletivo's incremental build. Persists to
 * `node_modules/.pletivo/cache/cache.json`. Tracks per-route dep fingerprints,
 * fragment registrations, getStaticPaths memoization, and bookkeeping
 * for the persistent `dist/` directory.
 *
 * `persist()` is a no-op when the cache wasn't mutated this build, so
 * warm noop builds don't pay for a JSON serialize/write.
 */
export class CacheStore {
  private data: PletivoCache;
  private invalidated = false;
  private dirty = false;

  private constructor(public readonly dir: string, private readonly outDir: string, data: PletivoCache) {
    this.data = data;
  }

  /** `outDir` is the output directory relative to the project root; a route output record of another one is not used. */
  static async load(projectRoot: string, configHash: string, outDir: string): Promise<CacheStore> {
    const dir = cacheDir(projectRoot);
    const empty: PletivoCache = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      pletivoVersion: PLETIVO_VERSION,
      configHash,
      routes: {},
      dynamicRoutes: {},
      virtualCss: {},
      routeOutputs: null,
    };

    const cachePath = path.join(dir, "cache.json");
    try {
      const raw = await fs.readFile(cachePath, "utf8");
      const parsed = JSON.parse(raw) as PletivoCache;
      const routeOutputs = parseRouteOutputs(parsed.routeOutputs);
      // Without it a stale route output cannot be told from the rest of `dist/`, so the build is cold.
      if (routeOutputs === null || routeOutputs.outDir !== outDir) return new CacheStore(dir, outDir, empty);
      // A build that changed `dist/` and didn't persist left the cache describing an older `dist/`.
      // Its route outputs are still files an earlier build wrote, so they stay prunable.
      if (await fs.stat(path.join(dir, WRITING_MARKER)).then(() => true, () => false)) {
        return new CacheStore(dir, outDir, { ...empty, routeOutputs });
      }
      if (
        parsed.schemaVersion === CACHE_SCHEMA_VERSION &&
        parsed.pletivoVersion === PLETIVO_VERSION &&
        parsed.configHash === configHash &&
        typeof parsed.routes === "object" &&
        parsed.routes !== null
      ) {
        // dynamicRoutes is optional in older caches; default to empty.
        if (!parsed.dynamicRoutes || typeof parsed.dynamicRoutes !== "object") {
          parsed.dynamicRoutes = {};
        }
        if (!parsed.virtualCss || typeof parsed.virtualCss !== "object") {
          parsed.virtualCss = {};
        }
        return new CacheStore(dir, outDir, { ...parsed, routeOutputs });
      }
      return new CacheStore(dir, outDir, { ...empty, routeOutputs });
    } catch {
      // No cache or a corrupt one — fall through to empty.
    }
    return new CacheStore(dir, outDir, empty);
  }

  /** A build without the cache rewrites `dist/`, so the cache no longer describes it. */
  static async discard(projectRoot: string): Promise<void> {
    await fs.rm(cacheDir(projectRoot), { recursive: true, force: true });
  }

  static async forceClean(projectRoot: string, configHash: string, outDir: string): Promise<CacheStore> {
    const dir = cacheDir(projectRoot);
    await fs.rm(dir, { recursive: true, force: true });
    return new CacheStore(dir, outDir, {
      schemaVersion: CACHE_SCHEMA_VERSION,
      pletivoVersion: PLETIVO_VERSION,
      configHash,
      routes: {},
      dynamicRoutes: {},
      virtualCss: {},
      routeOutputs: null,
    });
  }


  getRoute(key: string): RouteCacheEntry | undefined {
    return this.data.routes[key];
  }

  setRoute(key: string, entry: RouteCacheEntry): void {
    this.data.routes[key] = entry;
    this.dirty = true;
  }

  deleteRoute(key: string): void {
    if (key in this.data.routes) {
      delete this.data.routes[key];
      this.dirty = true;
    }
  }

  routeKeys(): string[] {
    return Object.keys(this.data.routes);
  }

  pruneRoutes(keepKeys: Set<string>): void {
    for (const key of Object.keys(this.data.routes)) {
      if (!keepKeys.has(key)) {
        delete this.data.routes[key];
        this.dirty = true;
      }
    }
    const listed = new Set(Object.values(this.data.routes).flatMap((entry) => entry.dynamicCss));
    for (const file of Object.keys(this.data.virtualCss)) {
      if (!listed.has(file)) {
        delete this.data.virtualCss[file];
        this.dirty = true;
      }
    }
  }

  virtualCss(file: string): string | undefined {
    return this.data.virtualCss[file];
  }

  setVirtualCss(file: string, css: string): void {
    if (this.data.virtualCss[file] === css) return;
    this.data.virtualCss[file] = css;
    this.dirty = true;
  }

  getDynamicRoute(routeFile: string): DynamicRouteCacheEntry | undefined {
    return this.data.dynamicRoutes[routeFile];
  }

  setDynamicRoute(routeFile: string, entry: DynamicRouteCacheEntry): void {
    this.data.dynamicRoutes[routeFile] = entry;
    this.dirty = true;
  }

  pruneDynamicRoutes(keepFiles: Set<string>): void {
    for (const key of Object.keys(this.data.dynamicRoutes)) {
      if (!keepFiles.has(key)) {
        delete this.data.dynamicRoutes[key];
        this.dirty = true;
      }
    }
  }

  /**
   * Files the last build wrote for its routes into `outDir`. Null when there is no usable record:
   * the build is cold, with an empty render cache, and must clear `dist/` as a plain build does.
   */
  routeOutputs(): string[] | null {
    return this.data.routeOutputs?.files ?? null;
  }

  setRouteOutputs(files: Iterable<string>): void {
    const next: RouteOutputs = { outDir: this.outDir, files: [...files].sort() };
    const prev = this.data.routeOutputs;
    if (prev && prev.outDir === next.outDir && prev.files.join("\0") === next.files.join("\0")) return;
    this.data.routeOutputs = next;
    this.dirty = true;
  }

  /** True when nothing has mutated the cache since load. */
  isClean(): boolean {
    return !this.dirty;
  }

  /** Mark the cache as suspect; persist() becomes a no-op. */
  invalidate(): void {
    this.invalidated = true;
  }

  /**
   * Call before writing `dist/`. Until `persist()` succeeds, the next load starts empty: an interrupted build may
   * have changed pages the cache records as unchanged. A marker, so a no-op warm build still skips the JSON write.
   */
  async markWriting(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(path.join(this.dir, WRITING_MARKER), "");
  }

  async persist(): Promise<void> {
    if (this.invalidated) return;
    if (this.dirty) {
      await fs.mkdir(this.dir, { recursive: true });
      await fs.writeFile(
        path.join(this.dir, "cache.json"),
        JSON.stringify(this.data, null, 2),
      );
      this.dirty = false;
    }
    await fs.rm(path.join(this.dir, WRITING_MARKER), { force: true });
  }

}

/** A stored record names files to delete, so a path that is not plainly inside the output directory voids it. */
function parseRouteOutputs(value: unknown): RouteOutputs | null {
  if (typeof value !== "object" || value === null || !("outDir" in value) || !("files" in value)) return null;
  const { outDir, files } = value;
  if (typeof outDir !== "string" || !Array.isArray(files)) return null;
  const items: unknown[] = files;
  const parsed: string[] = [];
  for (const file of items) {
    if (typeof file !== "string" || !isInsideOutDir(file)) return null;
    parsed.push(file);
  }
  return { outDir, files: parsed };
}

function isInsideOutDir(rel: string): boolean {
  return !path.isAbsolute(rel) && path.normalize(rel) === rel && rel !== "." && rel.split(path.sep)[0] !== "..";
}

/**
 * Per-build memoization of `fingerprintFile`. Many routes share deps
 * (Layout, shared components, …) — without the cache we'd re-stat and
 * re-hash the same file once per route that imports it. With ~1500
 * routes and ~5–10 shared deps, that's thousands of redundant reads.
 *
 * `_resetFingerprintCacheForTests` is exposed for unit tests that
 * exercise the dep-hash code path with synthetic files.
 */
const fingerprintCache = new Map<string, Promise<DepFingerprint>>();

export function _resetFingerprintCacheForTests(): void {
  fingerprintCache.clear();
}

export function fingerprintFile(filePath: string): Promise<DepFingerprint> {
  let cached = fingerprintCache.get(filePath);
  if (!cached) {
    cached = fingerprintFileImpl(filePath);
    fingerprintCache.set(filePath, cached);
  }
  return cached;
}

async function fingerprintFileImpl(filePath: string): Promise<DepFingerprint> {
  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      // Directories are tracked as deps for things like a glob's scan
      // root — a per-file fingerprint can't detect a *new* file by
      // itself (there's nothing to compare against). Hashing the
      // recursive listing solves that.
      const listing = await collectDirListing(filePath);
      const hash = Bun.hash(listing.join("\n")).toString(16);
      return { mtimeMs: stat.mtimeMs, size: listing.length, hash };
    }
    // We defer the content hash — it's lazy, only computed when
    // mtime+size disagree on rebuild (`canReuseFingerprint` below).
    // Caching the hash inline at write time keeps the comparison
    // cheap even in the slow path.
    const buf = await Bun.file(filePath).arrayBuffer();
    const hash = Bun.hash(buf as ArrayBuffer).toString(16);
    return { mtimeMs: stat.mtimeMs, size: stat.size, hash };
  } catch {
    return { mtimeMs: 0, size: -1, hash: "__missing__" };
  }
}

/**
 * Fast path: stat the file. If mtime+size match the cached fingerprint
 * we trust it without reading bytes. Slow fallback: when mtime drifted
 * but size still matches, re-hash and compare content — covers e.g.
 * `touch`-only edits.
 *
 * For directories we always re-hash the listing — the mtime fast-path
 * is unreliable across filesystems for nested changes, and the listing
 * scan is cheap relative to a full render.
 */
export async function canReuseFingerprint(filePath: string, prev: DepFingerprint): Promise<boolean> {
  let stat: { mtimeMs: number; size: number; isDirectory: boolean };
  try {
    const s = await fs.stat(filePath);
    stat = { mtimeMs: s.mtimeMs, size: s.size, isDirectory: s.isDirectory() };
  } catch {
    return false;
  }
  if (stat.isDirectory) {
    const listing = await collectDirListing(filePath);
    const h = Bun.hash(listing.join("\n")).toString(16);
    return h === prev.hash;
  }
  if (stat.size !== prev.size) return false;
  if (stat.mtimeMs === prev.mtimeMs) return true;
  // mtime drifted, size matches → only re-hash if it might actually
  // be a real edit. Cheaper than a full hash on every dep.
  try {
    const buf = await Bun.file(filePath).arrayBuffer();
    const h = Bun.hash(buf as ArrayBuffer).toString(16);
    return h === prev.hash;
  } catch {
    return false;
  }
}

/**
 * Recursive sorted listing of a directory's entries, returned as paths
 * relative to `dir`. Used as the input to a directory fingerprint hash.
 */
async function collectDirListing(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string, rel: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(current, entry.name), childRel);
      } else if (entry.isFile()) {
        out.push(childRel);
      }
    }
  }
  await walk(dir, "");
  out.sort();
  return out;
}

/**
 * Identity of one param set of a dynamic route, used in route cache keys and
 * to find a slug's props among `getStaticPaths()` results.
 */
export function paramsToKey(params: Record<string, string | undefined>): string {
  // `routeToOutputPath` treats a missing, `undefined` or empty param alike, and
  // a cached param set has lost its `undefined` keys to JSON.
  const present = Object.keys(params).filter((k) => params[k] !== undefined && params[k] !== "");
  return present.sort().map((k) => `${k}=${params[k]}`).join("&");
}

export function cacheDir(projectRoot: string): string {
  return path.join(projectRoot, "node_modules", ".pletivo", "cache");
}

/**
 * Stable hash of inputs that, if changed, should invalidate every route
 * in the cache. Includes pletivo config + the astro config file's
 * content + the pletivo version (caller may add more parts).
 */
export async function computeConfigHash(parts: Array<string | Buffer>): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for (const p of parts) hasher.update(p);
  return hasher.digest("hex").slice(0, 16);
}

/**
 * Content hash of a file. Returns `__missing__` if the file does not
 * exist — used as a stable sentinel so cache comparisons treat missing
 * files as having changed.
 */
export async function hashFileContent(filePath: string): Promise<string> {
  try {
    const buf = await Bun.file(filePath).arrayBuffer();
    return Bun.hash(buf as ArrayBuffer).toString(16);
  } catch {
    return "__missing__";
  }
}

export function hashString(s: string): string {
  return Bun.hash(s).toString(16);
}
