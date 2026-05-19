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
export const CACHE_SCHEMA_VERSION = 4;

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
   * params, not props. Always JSON-safe (params are strings), so this
   * cache works for every dynamic route, including collection-backed
   * ones whose props carry non-serializable values (`render()`
   * methods, Dates, etc.).
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

export interface PletivoCache {
  schemaVersion: number;
  pletivoVersion: string;
  configHash: string;
  routes: Record<string, RouteCacheEntry>;
  dynamicRoutes: Record<string, DynamicRouteCacheEntry>;
}

/**
 * On-disk cache backing pletivo's incremental build. Persists to
 * `.pletivo/cache/cache.json`. Tracks per-route dep fingerprints,
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

  private constructor(public readonly dir: string, data: PletivoCache) {
    this.data = data;
  }

  static async load(projectRoot: string, configHash: string): Promise<CacheStore> {
    const dir = cacheDir(projectRoot);
    const empty: PletivoCache = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      pletivoVersion: PLETIVO_VERSION,
      configHash,
      routes: {},
      dynamicRoutes: {},
    };

    const cachePath = path.join(dir, "cache.json");
    try {
      const raw = await fs.readFile(cachePath, "utf8");
      const parsed = JSON.parse(raw) as PletivoCache;
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
        return new CacheStore(dir, parsed);
      }
    } catch {
      // No cache, corrupt cache, or version mismatch — fall through to empty.
    }
    return new CacheStore(dir, empty);
  }

  static async forceClean(projectRoot: string, configHash: string): Promise<CacheStore> {
    const dir = cacheDir(projectRoot);
    await fs.rm(dir, { recursive: true, force: true });
    return new CacheStore(dir, {
      schemaVersion: CACHE_SCHEMA_VERSION,
      pletivoVersion: PLETIVO_VERSION,
      configHash,
      routes: {},
      dynamicRoutes: {},
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

  /** True when nothing has mutated the cache since load. */
  isClean(): boolean {
    return !this.dirty;
  }

  /** Mark the cache as suspect; persist() becomes a no-op. */
  invalidate(): void {
    this.invalidated = true;
  }

  async persist(): Promise<void> {
    if (this.invalidated) return;
    if (!this.dirty) return;
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(
      path.join(this.dir, "cache.json"),
      JSON.stringify(this.data, null, 2),
    );
    this.dirty = false;
  }

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

export function cacheDir(projectRoot: string): string {
  return path.join(projectRoot, ".pletivo", "cache");
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
