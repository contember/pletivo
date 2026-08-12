/**
 * Content collections: schemas, the store, the loader protocol, and the query API.
 *
 * Everything here is host-agnostic. What is not — walking a directory, reading a
 * file, importing the project's `content.config.*`, probing an image — goes through
 * `ContentHost`, which a host installs once with `setContentHost()`. The Bun host
 * backs it with `Bun.Glob` and `Bun.file`; the Workers host backs it with a binding
 * to whoever holds the sources, since an isolate has no filesystem at all.
 *
 * The seam is deliberately narrow: it answers *where the bytes are*, never *what
 * they mean*. Frontmatter parsing, Zod validation, id generation, reference
 * resolution, `render()` memoization and entry ordering are the same code on both
 * hosts, which is the only way the two can agree byte for byte.
 */

import { z } from "zod";
import { renderMarkdown, parseFrontmatter, parseYamlObject } from "./markdown";
import type { ImageMetadata } from "../image-service";

// ── Types ──

export interface RawEntry {
  id: string;
  body: string;
  data: Record<string, unknown>;
}

/** Legacy pletivo loader — returns entries directly. */
export interface Loader {
  load(projectRoot: string): Promise<RawEntry[]>;
  /** Internal: raw base dir of a glob() loader, read to watch content outside `src/`. */
  __globBase?: string;
}

/**
 * Astro Content Layer loader — pushes entries into a store.
 * Compatible with CMS integration loaders (Sanity, Contentful, etc.).
 */
export interface AstroLoader {
  name: string;
  load(context: LoaderContext): Promise<void>;
  schema?: z.ZodType;
}

/** Entry shape for DataStore.set() */
export interface DataStoreEntry {
  id: string;
  data: Record<string, unknown>;
  body?: string;
  rendered?: { html: string };
}

export interface DataStore {
  set(entry: DataStoreEntry): void;
  get(id: string): DataStoreEntry | undefined;
  has(id: string): boolean;
  delete(id: string): boolean;
  clear(): void;
  keys(): IterableIterator<string>;
  values(): IterableIterator<DataStoreEntry>;
  entries(): IterableIterator<[string, DataStoreEntry]>;
}

export interface MetaStore {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  has(key: string): boolean;
  delete(key: string): boolean;
}

export interface LoaderContext {
  /** Collection name */
  collection: string;
  /** Key-value store to push entries into */
  store: DataStore;
  /** Persistent metadata (in-memory for SSG builds) */
  meta: MetaStore;
  /** Logger scoped to the loader */
  logger: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
  /** Astro config reference (if available) */
  config: Record<string, unknown>;
  /** Validate entry data against the collection's Zod schema */
  parseData<T = Record<string, unknown>>(props: { id: string; data: T }): Promise<T>;
}

/**
 * Function loader — simplest form: returns array of entry objects.
 * Each object must have `id`; remaining keys become `data`.
 */
export type FunctionLoader = () => Promise<Array<Record<string, unknown> & { id: string }>>;

/** Any supported loader type */
export type AnyLoader = Loader | AstroLoader | FunctionLoader;

/**
 * Reference marker returned by `reference(collectionName)`. Passed through
 * Zod as a pass-through schema — validation stores the id string, and
 * `getEntry(ref)` resolves it to the actual entry at runtime.
 */
export interface Reference {
  collection: string;
  id: string;
  __pletivoReference: true;
}

/**
 * Astro-compatible `reference()`. Returns a Zod schema that accepts a string
 * id (or an object with `{ id, collection }`) and stores it as a Reference
 * marker. `getEntry(ref)` resolves the marker to the target entry.
 */
export function reference(collectionName: string): z.ZodType<Reference> {
  return z
    .union([z.string(), z.object({ id: z.string(), collection: z.string() })])
    .transform((value): Reference => {
      if (typeof value === "string") {
        return { collection: collectionName, id: value, __pletivoReference: true };
      }
      return { collection: value.collection, id: value.id, __pletivoReference: true };
    });
}

/**
 * The `image()` schema itself, which is the same on every host.
 *
 * What differs is only how a path becomes bytes: the Bun host opens the file, the
 * Workers host asks the content binding. Everything a *schema author* can get wrong —
 * a remote URL, a root-absolute path, an entry with no file behind it — is decided
 * here, so both hosts refuse the same frontmatter with the same words. `resolve`
 * throwing is the "could not read it" case; its message becomes the issue's.
 *
 * Accepted path forms:
 *  - Relative (`./logo.png`, `../assets/foo.png`) — against the entry file's directory.
 *  - Root-absolute (`/uploads/foo.png`) — rejected; use plain `z.string()`.
 *  - Remote URLs (`https://...`) — rejected; use `z.string().url()`.
 */
export function imageSchemaFor(
  /** Null for an entry with no source file (a function loader): `image()` then fails. */
  entryDir: string | null,
  resolve: (entryDir: string, relativePath: string) => Promise<ImageMetadata>,
): z.ZodType<ImageMetadata, unknown> {
  return z.string().transform(async (relPath: string, ctx: z.RefinementCtx) => {
    const fail = (message: string) => {
      ctx.addIssue({ code: "custom", message });
      return z.NEVER;
    };

    if (!entryDir) {
      return fail(
        "image() schema can only be used with file-backed entries (e.g. glob() loader)",
      );
    }
    if (/^https?:\/\//i.test(relPath)) {
      return fail(
        `image() does not support remote URLs (got "${relPath}"). ` +
          `Use z.string().url() for remote images.`,
      );
    }
    if (relPath.startsWith("/")) {
      return fail(
        `image() resolves paths relative to the entry file (got "${relPath}"). ` +
          `For files in public/, use plain z.string() and reference them by absolute URL.`,
      );
    }

    try {
      return await resolve(entryDir, relPath);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  });
}

/**
 * Schema-context helpers passed to the function form of `schema`. Mirrors
 * Astro's API: `schema: ({ image }) => z.object({ logo: image() })`.
 *
 * The `image()` factory must be obtained from this context (not imported)
 * because it closes over the entry's source directory so that relative
 * frontmatter paths resolve against the entry file's location.
 */
export interface SchemaContext {
  image: () => z.ZodType<ImageMetadata, unknown>;
}

export type SchemaFn = (ctx: SchemaContext) => z.ZodType;

export interface CollectionConfig {
  /** Loader that provides raw entries. Accepts glob(), Astro Content Layer loaders, or inline functions. */
  loader?: AnyLoader;
  /** Shorthand for loader: glob({ base: directory }) */
  directory?: string;
  /**
   * Zod schema for frontmatter validation. Either a static Zod schema, or a
   * function form `({ image }) => z.object({...})` that receives schema
   * helpers — match Astro's content-collection API.
   */
  schema: z.ZodType | SchemaFn;
  /** Optional HTML transform applied after markdown rendering */
  transform?: (html: string, data: Record<string, unknown>) => string;
}

export interface RenderResult {
  html: string;
}

export interface CollectionEntry<T = Record<string, unknown>> {
  id: string;
  data: T;
  body: string;
  /**
   * Render the entry's body to HTML. For MDX entries, `components` maps
   * MDX element names to components (Astro's `<Content components={...} />`),
   * e.g. so a bare `<Youtube />` in the body resolves without an import.
   */
  render(components?: Record<string, unknown>): Promise<RenderResult>;
}

// ── The host seam ──

/** One file a scan found. */
export interface ContentFile {
  /**
   * Path relative to the scan root, `/`-separated. This is what `generateId`
   * receives as `entry`, and what the default id generator strips an extension
   * from — so it is part of the observable output, not an implementation detail.
   */
  entry: string;
  /** Whatever `readFile` takes. Recorded on the entry as `_filePath`. */
  path: string;
}

export interface ContentScan {
  /**
   * The directory that was walked. Recorded as a dep of the collection so that a
   * file appearing or disappearing invalidates it — a per-file check cannot see
   * a file that is not there yet.
   */
  root: string;
  /** `file://` URL of `root` (trailing separator), which `generateId` receives as `base`. */
  rootUrl: URL;
  /**
   * Sorted by `entry`.
   *
   * Sorting is the host's job because it is the host that enumerates, and it is
   * not optional: `Bun.Glob.scan()` yields in filesystem order, which on ext4 is a
   * per-volume filename hash — so an unsorted `getCollection()` returns entries in
   * a different order on a different machine, and any page listing a collection
   * renders differently. It is also what lets a second host enumerating from a
   * virtual file map agree with Bun.
   */
  files: ContentFile[];
}

/**
 * What a collection needs that only a host can answer.
 *
 * Required: enumerate, read, locate. Optional: the capabilities a host may simply
 * not have — an isolate cannot probe an image off disk or import an `.mdx` module,
 * and each absent hook turns into a clear validation error rather than a crash.
 */
export interface ContentHost {
  /** Files under `base` (project-root-relative) matching `pattern`. Empty when the directory does not exist. */
  scan(projectRoot: string, base: string, pattern: string): Promise<ContentScan>;
  /** A file's text, by the `path` a scan reported. */
  readFile(path: string): Promise<string>;
  /** The directory a file sits in — where a relative `image()` path resolves from. */
  dirname(path: string): string;
  /** Absolute (host-shaped) form of a project-root-relative directory, for `getContentBaseDirs`. */
  resolveDir(projectRoot: string, base: string): string;
  /**
   * The project's collection definitions, by executing its `content.config.*`.
   * `version` increments on every `initCollections()` so a host that caches
   * modules can bust its cache.
   */
  loadConfig(projectRoot: string, version: number): Promise<Record<string, CollectionConfig>>;
  /** Record a file the current render depends on. Bun host: the incremental cache. */
  recordDep?(path: string): void;
  /** `image()` bound to an entry's directory. Absent: image() schemas fail with a clear message. */
  image?(entryDir: string | null): z.ZodType<ImageMetadata, unknown>;
  /** Render an `.mdx` entry's body to HTML. Absent: `.mdx` entries fail with a clear message. */
  renderMdx?(
    filePath: string,
    components: Record<string, unknown> | undefined,
    version: number,
  ): Promise<string>;
  /** Astro config surfaced to a Content Layer loader as `context.config`. */
  loaderConfig?(): Record<string, unknown> | Promise<Record<string, unknown>>;
}

let contentHost: ContentHost | null = null;

/**
 * Install the host. Called once per process by the Bun host, and once per request
 * by the Workers host — see the note on `initCollections` about why the second one
 * has to be per request.
 */
export function setContentHost(host: ContentHost): void {
  contentHost = host;
}

function requireHost(): ContentHost {
  if (!contentHost) {
    throw new Error(
      "Content collections have no host. Import `pletivo/content` (Bun) or call " +
        "`setContentHost()` before using a collection.",
    );
  }
  return contentHost;
}

// ── Built-in loaders ──

export interface GlobOptions {
  /** Glob pattern (default: "**\/*.md") */
  pattern?: string;
  /** Base directory relative to project root */
  base: string;
  /**
   * Astro-compatible ID generator. Receives the file's path relative to
   * `base`, the absolute base URL, and the parsed frontmatter data, and
   * returns the entry ID. Defaults to stripping the extension while
   * preserving subdirectory structure (e.g. `cs/praha-2.md` → `cs/praha-2`).
   *
   * Common use case: collapse `index` files to their parent directory:
   *   generateId: ({ entry }) => entry.replace(/\/index\.md$/, "").replace(/\.md$/, "")
   */
  generateId?: (params: {
    entry: string;
    base: URL;
    data: Record<string, unknown>;
  }) => string;
}

/**
 * File-based loader — scans a directory for content files.
 * Compatible with Astro's glob() loader pattern.
 *
 * Supported extensions:
 *  - `.md` → markdown parse (built-in parser)
 *  - `.mdx` → frontmatter extracted, body compiled by the host (see `renderMdx`)
 *  - `.json` → JSON.parse as frontmatter, empty body
 *  - `.yaml`, `.yml` → YAML parse as frontmatter, empty body
 */
export function glob(options: GlobOptions): Loader {
  // `__scanRoots` lets loadCollection() learn which directories this
  // loader walked, so the incremental cache can fingerprint each as a
  // dep (catches add/remove of files in the collection — per-file
  // mtime+size checks miss new files since the cache has nothing to
  // compare against).
  const loader: Loader & { __scanRoots?: string[] } = {
    // Raw base dir — read at dev-server startup (see getContentBaseDirs) to watch
    // content that lives outside `src/`, without having to load the collection first.
    __globBase: options.base,
    async load(projectRoot: string): Promise<RawEntry[]> {
      const host = requireHost();
      const scan = await host.scan(projectRoot, options.base, options.pattern ?? "**/*.{md,mdx}");
      loader.__scanRoots = [scan.root];
      const entries: RawEntry[] = [];

      for (const { entry: file, path: fullPath } of scan.files) {
        const content = await host.readFile(fullPath);
        const ext = extensionOf(file);

        // Per-extension parsing produces (data, body, extras) — extras
        // hold internal hints (_filePath, _html, _mdxFilePath) that the
        // schema strips before validation.
        let data: Record<string, unknown>;
        let body = "";
        let extras: Record<string, unknown>;

        if (ext === ".json") {
          try {
            data = JSON.parse(content);
          } catch (e) {
            console.error(`  JSON parse error in ${file}: ${(e as Error).message}`);
            continue;
          }
          extras = { _filePath: fullPath };
        } else if (ext === ".yaml" || ext === ".yml") {
          try {
            data = parseYamlObject(content);
          } catch (e) {
            console.error(`  YAML parse error in ${file}: ${(e as Error).message}`);
            continue;
          }
          extras = { _filePath: fullPath };
        } else if (ext === ".mdx") {
          const parsed = parseFrontmatter(content);
          data = parsed.frontmatter;
          body = parsed.body;
          extras = { _filePath: fullPath, _mdxFilePath: fullPath };
        } else {
          // Parse frontmatter eagerly, but defer rendering the markdown body
          // to HTML until `entry.render()` is called. Listing pages read only
          // frontmatter, so rendering every entry's body up front is wasted
          // work (dominant cost of loading a large collection).
          const parsed = parseFrontmatter(content);
          data = parsed.frontmatter;
          body = parsed.body;
          extras = { _filePath: fullPath };
        }

        const id = options.generateId
          ? options.generateId({ entry: file, base: scan.rootUrl, data })
          : file.replace(/\.(md|mdx|json|ya?ml)$/i, "");

        entries.push({ id, body, data: { ...data, ...extras } });
      }

      return entries;
    },
  };
  return loader;
}

/**
 * A path's lowercased extension, `path.extname` semantics (a leading dot in the
 * basename is not one). Written out rather than imported so this module needs no
 * `node:path`, which is what keeps it runnable inside a Worker isolate.
 */
function extensionOf(file: string): string {
  const slash = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
  const dot = file.lastIndexOf(".");
  return dot > slash + 1 ? file.slice(dot).toLowerCase() : "";
}

// ── defineCollection ──

export function defineCollection(config: CollectionConfig): CollectionConfig {
  // Sugar: directory → glob loader
  if (config.directory && !config.loader) {
    config.loader = glob({ base: config.directory });
  }
  return config;
}

// ── Runtime state ──

const collectionCache = new Map<string, CollectionEntry[]>();
/** In-flight loads keyed by collection name — concurrent getCollection() calls share one loadCollection() pass instead of racing. */
const collectionInflight = new Map<string, Promise<CollectionEntry[]>>();
/**
 * Per-collection set of paths that contribute to the loaded entries:
 * every entry's source file, plus the loader's scan root(s) so the
 * incremental cache can detect additions (the root dir's listing
 * fingerprint changes when a file appears/disappears). Populated when
 * `loadCollection` finishes; re-fired into the active runtime-dep
 * scope on every subsequent `getCollection` call so that pages which
 * hit the cached entries still attribute the deps to themselves.
 */
const collectionDeps = new Map<string, Set<string>>();
let collectionsConfig: Record<string, CollectionConfig> | null = null;
let configProjectRoot: string = "";
let configVersion = 0;

/**
 * Entries that failed schema validation since the last `initCollections()`.
 * Build.ts reads this after rendering and exits non-zero if non-empty,
 * so a typo in a frontmatter image path doesn't ship a "successful"
 * build with silently dropped entries.
 */
const validationFailures: Array<{ collection: string; id: string; errors: string }> = [];

export function getValidationFailures(): ReadonlyArray<{ collection: string; id: string; errors: string }> {
  return validationFailures;
}

/**
 * Load the project's collection definitions and drop every cached entry.
 *
 * The cache reset is the load-bearing half on a long-lived host. A Worker isolate
 * outlives the request that started it — deliberately, since keeping content out of
 * the module map is what lets one isolate serve many edits — so a store that
 * survived a request would answer the next one with the previous render's content.
 * Call this at the start of every render pass there; once per build is enough on Bun.
 */
export async function initCollections(projectRoot: string): Promise<void> {
  configProjectRoot = projectRoot;
  collectionCache.clear();
  collectionInflight.clear();
  collectionDeps.clear();
  validationFailures.length = 0;
  configVersion++;

  collectionsConfig = await requireHost().loadConfig(projectRoot, configVersion);
}

/**
 * Absolute base directories of every glob-backed collection, read from `collectionsConfig`
 * (so available right after `initCollections`, without loading any collection). The dev
 * server watches these for content that lives outside `src/` — e.g. a project-root
 * `content/` dir — which its `srcDir` watcher can't see, so a CMS/external write there
 * still invalidates the collection cache and reloads the preview.
 */
export function getContentBaseDirs(projectRoot: string): string[] {
  if (!collectionsConfig) return [];
  const host = requireHost();
  const dirs = new Set<string>();
  for (const config of Object.values(collectionsConfig)) {
    const loader = config.loader;
    const base = (loader && "__globBase" in loader ? loader.__globBase : undefined) ?? config.directory;
    if (typeof base === "string") dirs.add(host.resolveDir(projectRoot, base));
  }
  return [...dirs];
}

// ── Query API ──

export async function getCollection<T = Record<string, unknown>>(
  name: string,
  filter?: (entry: CollectionEntry<T>) => boolean,
): Promise<CollectionEntry<T>[]> {
  if (!collectionsConfig) {
    throw new Error("Collections not initialized. Call initCollections() first.");
  }

  const config = collectionsConfig[name];
  if (!config) {
    throw new Error(
      `Collection "${name}" not found. Define it in src/content.config.ts or src/content/config.ts`,
    );
  }

  let entries = collectionCache.get(name) as CollectionEntry<T>[] | undefined;
  if (!entries) {
    let inflight = collectionInflight.get(name) as
      | Promise<CollectionEntry<T>[]>
      | undefined;
    if (!inflight) {
      inflight = (async () => {
        const loaded = await loadCollection(config, name);
        collectionCache.set(name, loaded);
        return loaded as CollectionEntry<T>[];
      })();
      collectionInflight.set(name, inflight as Promise<CollectionEntry[]>);
      try {
        entries = await inflight;
      } finally {
        collectionInflight.delete(name);
      }
    } else {
      entries = await inflight;
    }
  }
  // Re-fire the collection's deps into the current capture scope so
  // every page that reads the collection (not just the first one)
  // ends up with the entry source files in its dep set. Without this,
  // pages that hit the warm `collectionCache` would record nothing
  // and would happily serve stale HTML after a content edit.
  republishCollectionDeps(name);
  if (filter) {
    entries = entries.filter(filter);
  }
  return entries;
}

function republishCollectionDeps(name: string): void {
  const deps = collectionDeps.get(name);
  if (!deps) return;
  const record = contentHost?.recordDep;
  if (!record) return;
  for (const p of deps) record(p);
}

/**
 * Astro-compatible `render(entry)` helper. Returns `{ Content }` where
 * `Content` is a component that emits the entry's HTML body.
 *
 * Rendering is deferred until `Content` is invoked so the `components` prop
 * from `<Content components={...} />` can be threaded into the (MDX) body —
 * imports in the body (JSX and .astro components) plus any passed components
 * are resolved at render time.
 */
export async function render(
  entry: CollectionEntry | null | undefined,
): Promise<{
  Content: (props?: { components?: Record<string, unknown> }) =>
    | { __html: string }
    | Promise<{ __html: string }>;
  headings: unknown[];
  remarkPluginFrontmatter: Record<string, unknown>;
}> {
  const Content = (props?: { components?: Record<string, unknown> }) => {
    if (!entry) return { __html: "" };
    return entry.render(props?.components).then((result) => ({ __html: result.html }));
  };
  return { Content, headings: [], remarkPluginFrontmatter: {} };
}

export async function getEntry<T = Record<string, unknown>>(
  nameOrRef: string | Reference | { collection: string; id: string } | undefined | null,
  id?: string,
): Promise<CollectionEntry<T> | undefined> {
  if (nameOrRef == null) return undefined;
  let collectionName: string;
  let entryId: string;
  if (typeof nameOrRef === "string") {
    if (id === undefined) return undefined;
    collectionName = nameOrRef;
    entryId = id;
  } else {
    collectionName = nameOrRef.collection;
    entryId = nameOrRef.id;
  }
  const entries = await getCollection<T>(collectionName);
  return entries.find((e) => e.id === entryId);
}

// ── Internal ──

/**
 * Detect loader type and load entries accordingly:
 *  1. Function loader — `() => Promise<Entry[]>`
 *  2. Astro Content Layer loader — `{ name, load(ctx) }`
 *  3. Legacy pletivo loader — `{ load(root) }` (glob, etc.)
 */
async function loadCollection(config: CollectionConfig, name: string): Promise<CollectionEntry[]> {
  if (!config.loader) {
    throw new Error(`Collection "${name}" has no loader. Use glob() or set directory.`);
  }

  let rawEntries: RawEntry[];

  if (typeof config.loader === "function") {
    // Function loader — returns array of entry objects
    rawEntries = await loadFromFunctionLoader(config.loader as FunctionLoader);
  } else if ("name" in config.loader && typeof (config.loader as AstroLoader).name === "string") {
    // Astro Content Layer loader
    rawEntries = await loadFromAstroLoader(config.loader as AstroLoader, config, name);
  } else {
    // Legacy pletivo loader (glob, etc.)
    rawEntries = await (config.loader as Loader).load(configProjectRoot);
  }

  const entries = await buildEntries(rawEntries, config, name);

  // Harvest the per-entry source paths + the loader's scan roots so
  // subsequent `getCollection` calls (cache hits) can re-fire them as
  // runtime deps. Scan roots are only known for the legacy `glob()`
  // loader, which stamps them onto the loader object as `__scanRoots`.
  const deps = new Set<string>();
  for (const e of entries) {
    const fp = (e as unknown as { _filePath?: unknown })._filePath;
    if (typeof fp === "string") deps.add(fp);
    const mfp = (e as unknown as { _mdxFilePath?: unknown })._mdxFilePath;
    if (typeof mfp === "string") deps.add(mfp);
  }
  const roots = (config.loader as { __scanRoots?: unknown }).__scanRoots;
  if (Array.isArray(roots)) {
    for (const r of roots) if (typeof r === "string") deps.add(r);
  }
  collectionDeps.set(name, deps);
  // Fire once now into the active scope — the call that triggered
  // this load should also get the deps attributed.
  republishCollectionDeps(name);

  return entries;
}

/** Run a function loader and normalize its output to RawEntry[]. */
async function loadFromFunctionLoader(loader: FunctionLoader): Promise<RawEntry[]> {
  const results = await loader();
  return results.map((item) => {
    const { id, body, ...data } = item;
    return { id, body: typeof body === "string" ? body : "", data };
  });
}

/** Run an Astro Content Layer loader with a full LoaderContext. */
async function loadFromAstroLoader(loader: AstroLoader, config: CollectionConfig, name: string): Promise<RawEntry[]> {
  const storeMap = new Map<string, DataStoreEntry>();
  const metaMap = new Map<string, unknown>();

  const store: DataStore = {
    set(entry) { storeMap.set(entry.id, entry); },
    get(id) { return storeMap.get(id); },
    has(id) { return storeMap.has(id); },
    delete(id) { return storeMap.delete(id); },
    clear() { storeMap.clear(); },
    keys() { return storeMap.keys(); },
    values() { return storeMap.values(); },
    entries() { return storeMap.entries(); },
  };

  const meta: MetaStore = {
    get(key) { return metaMap.get(key); },
    set(key, value) { metaMap.set(key, value); },
    has(key) { return metaMap.has(key); },
    delete(key) { return metaMap.delete(key); },
  };

  const logger = {
    info(msg: string) { console.log(`[${loader.name}] ${msg}`); },
    warn(msg: string) { console.warn(`[${loader.name}] ${msg}`); },
    error(msg: string) { console.error(`[${loader.name}] ${msg}`); },
  };

  // The loader's own schema (if provided) takes precedence over the
  // collection's schema. Either form may be a function — `image()` is
  // not meaningful for entries without an `_filePath`, so the factory
  // resolves with `null` here and any image() call surfaces a clear
  // error.
  const schemaSpec = (loader.schema ?? config.schema) as z.ZodType | SchemaFn;
  const resolveForDir = makeSchemaResolver(schemaSpec);

  const context: LoaderContext = {
    collection: name,
    store,
    meta,
    logger,
    config: {},
    async parseData<T>({ id, data }: { id: string; data: T }): Promise<T> {
      const filePath = (data as Record<string, unknown>)?._filePath;
      const entryDir = typeof filePath === "string" ? requireHost().dirname(filePath) : null;
      const schema = resolveForDir(entryDir);
      const result = await schema.safeParseAsync(data);
      if (!result.success) {
        const errors = result.error instanceof z.ZodError
          ? result.error.issues.map((i: z.ZodIssue) => `${i.path.join(".")}: ${i.message}`).join(", ")
          : String(result.error);
        throw new Error(`Validation error in ${name}/${id}: ${errors}`);
      }
      return result.data as T;
    },
  };

  // Provide the host's config if it has one to give.
  const loaderConfig = contentHost?.loaderConfig;
  if (loaderConfig) {
    context.config = await loaderConfig.call(contentHost);
  }

  await loader.load(context);

  // Convert store entries to RawEntry[]
  const rawEntries: RawEntry[] = [];
  for (const entry of storeMap.values()) {
    rawEntries.push({
      id: entry.id,
      body: entry.body ?? "",
      data: {
        ...entry.data,
        ...(entry.rendered ? { _html: entry.rendered.html } : {}),
      },
    });
  }
  return rawEntries;
}

/**
 * The `image()` factory for entries in `entryDir`, or one that fails with the
 * reason this host cannot provide it. Resolving an image needs the bytes of a file
 * that is not content — a Worker isolate has no way to reach it, so it says so at
 * the point of use instead of producing a broken `src`.
 */
function resolveImageFactory(entryDir: string | null): () => z.ZodType<ImageMetadata, unknown> {
  const factory = contentHost?.image;
  if (!factory) {
    return () =>
      z.string().transform((_value: string, ctx: z.RefinementCtx) => {
        ctx.addIssue({
          code: "custom",
          message:
            "image() schemas need a host that can read image files, and this one cannot. " +
            "Use plain z.string() for a URL you already know.",
        });
        return z.NEVER;
      });
  }
  return () => factory.call(contentHost, entryDir);
}

/**
 * Build a per-load resolver for a CollectionConfig.schema. Static schemas
 * pass through unchanged. Function schemas are evaluated once per
 * entryDir and cached, so a collection of N entries in M directories
 * produces M Zod schemas instead of N.
 */
function makeSchemaResolver(
  schema: z.ZodType | SchemaFn,
): (entryDir: string | null) => z.ZodType {
  if (typeof schema !== "function") {
    return () => schema;
  }
  const cache = new Map<string, z.ZodType>();
  return (entryDir) => {
    const key = entryDir ?? "";
    let resolved = cache.get(key);
    if (!resolved) {
      resolved = schema({ image: resolveImageFactory(entryDir) });
      cache.set(key, resolved);
    }
    return resolved;
  };
}

/**
 * Validate raw entries against the schema and build CollectionEntry
 * objects. Validation runs in parallel — image()-bearing schemas read
 * files asynchronously, so a sequential loop serialises N file probes.
 * Results are sorted back into source order before being returned so
 * entry order, error logs, and `validationFailures` stay deterministic.
 */
type EntryOutcome =
  | { kind: "ok"; entry: CollectionEntry }
  | { kind: "fail"; id: string; errors: string };

async function buildEntries(rawEntries: RawEntry[], config: CollectionConfig, name: string): Promise<CollectionEntry[]> {
  const host = requireHost();
  const resolveForDir = makeSchemaResolver(config.schema);

  const outcomes = await Promise.all(
    rawEntries.map(async (raw): Promise<EntryOutcome> => {
      const { _html, _mdxFilePath, _filePath, ...userData } = raw.data;
      const entryDir = typeof _filePath === "string" ? host.dirname(_filePath) : null;
      const schema = resolveForDir(entryDir);
      const result = await schema.safeParseAsync(userData);

      if (!result.success) {
        const errors = result.error instanceof z.ZodError
          ? result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")
          : String(result.error);
        return { kind: "fail", id: raw.id, errors };
      }

      if (_mdxFilePath) {
        const mdxPath = _mdxFilePath as string;
        const validatedData = result.data as Record<string, unknown>;
        const entry: CollectionEntry = {
          id: raw.id,
          data: validatedData,
          body: raw.body,
          render: async (components) => {
            const renderMdx = host.renderMdx;
            if (!renderMdx) {
              throw new Error(
                `Cannot render ${mdxPath}: .mdx entries need a host that can compile and ` +
                  "import a module, and this one cannot.",
              );
            }
            // Pass `components` so bare MDX element references (e.g. a
            // `<Youtube />` with no import) resolve, mirroring Astro's
            // `<Content components={...} />`.
            let html = await renderMdx.call(host, mdxPath, components, configVersion);
            if (config.transform) {
              html = config.transform(html, validatedData);
            }
            return { html };
          },
        };
        attachSourcePath(entry, _filePath, _mdxFilePath);
        return { kind: "ok", entry };
      }

      const validatedData = result.data as Record<string, unknown>;
      // Pre-rendered HTML from an Astro Content Layer loader (entry.rendered)
      // is used as-is; a glob() `.md` entry has no `_html` and renders its
      // body lazily on first `render()`. Either way the result is memoized so
      // repeated renders don't re-run the markdown pipeline.
      const preRendered = typeof _html === "string" ? _html : undefined;
      let renderedHtml: string | null = null;
      const entry: CollectionEntry = {
        id: raw.id,
        data: validatedData,
        body: raw.body,
        render: async () => {
          if (renderedHtml === null) {
            let html = preRendered ?? (await renderMarkdown(raw.body));
            if (config.transform) html = config.transform(html, validatedData);
            renderedHtml = html;
          }
          return { html: renderedHtml };
        },
      };
      attachSourcePath(entry, _filePath, _mdxFilePath);
      return { kind: "ok", entry };
    }),
  );

  const entries: CollectionEntry[] = [];
  for (const outcome of outcomes) {
    if (outcome.kind === "fail") {
      console.error(`Validation error in ${name}/${outcome.id}:\n${outcome.errors}`);
      validationFailures.push({ collection: name, id: outcome.id, errors: outcome.errors });
    } else {
      entries.push(outcome.entry);
    }
  }
  return entries;
}

export { z } from "zod";

/**
 * Re-stamp the entry with its source file path AFTER user-schema
 * validation strips it from `data`. Pletivo's incremental cache walks
 * `pathProps` looking for `_filePath` / `_mdxFilePath` markers to know
 * which content file backs each slug (since the read happens in
 * `getStaticPaths`, outside any per-slug capture scope). We attach it
 * at the entry level rather than under `data` so the user's schema
 * doesn't see it as a foreign field.
 */
function attachSourcePath(entry: CollectionEntry, filePath: unknown, mdxFilePath: unknown): void {
  if (typeof filePath === "string") {
    (entry as unknown as { _filePath: string })._filePath = filePath;
  }
  if (typeof mdxFilePath === "string") {
    (entry as unknown as { _mdxFilePath: string })._mdxFilePath = mdxFilePath;
  }
}
