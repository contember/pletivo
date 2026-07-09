import path from "path";
import fs from "fs";
import { pathToFileURL } from "url";
import { Glob } from "bun";
import { z } from "zod";
import { renderMarkdown, parseFrontmatter, parseYamlObject } from "./markdown";
import {
  imageUrlFor,
  makeImageMetadata,
  probeAndRegisterImage,
  type ImageMetadata,
} from "../image";
import { recordRuntimeDep } from "../incremental/dep-tracker";

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
 *  - `.mdx` → frontmatter extracted, body compiled via @mdx-js/mdx with
 *    full component import support (JSX and .astro components)
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
      const dir = path.resolve(projectRoot, options.base);
      loader.__scanRoots = [dir];
      if (!fs.existsSync(dir)) return [];
      const globPattern = new Glob(options.pattern ?? "**/*.{md,mdx}");
      const baseUrl = pathToFileURL(dir + path.sep);
      const entries: RawEntry[] = [];

      for await (const file of globPattern.scan(dir)) {
        const fullPath = path.join(dir, file);
        const content = await Bun.file(fullPath).text();
        const ext = path.extname(file).toLowerCase();

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
          ? options.generateId({ entry: file, base: baseUrl, data })
          : file.replace(/\.(md|mdx|json|ya?ml)$/i, "");

        entries.push({ id, body, data: { ...data, ...extras } });
      }

      return entries;
    },
  };
  return loader;
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

const CONTENT_CONFIG_CANDIDATES = [
  "src/content.config.ts",
  "src/content.config.mts",
  "src/content.config.mjs",
  "src/content.config.js",
  "src/content/config.ts",
  "src/content/config.mts",
  "src/content/config.mjs",
  "src/content/config.js",
];

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

export async function initCollections(projectRoot: string): Promise<void> {
  configProjectRoot = projectRoot;
  collectionCache.clear();
  collectionInflight.clear();
  collectionDeps.clear();
  validationFailures.length = 0;
  configVersion++;

  const configPath = await findContentConfigPath(projectRoot);

  if (configPath) {
    const mod = await import(configPath + `?v=${configVersion}`);
    collectionsConfig = mod.collections || {};
  } else {
    collectionsConfig = {};
  }
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
  const dirs = new Set<string>();
  for (const config of Object.values(collectionsConfig)) {
    const loader = config.loader;
    const base = (loader && "__globBase" in loader ? loader.__globBase : undefined) ?? config.directory;
    if (typeof base === "string") dirs.add(path.resolve(projectRoot, base));
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
  for (const p of deps) recordRuntimeDep(p);
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
      const entryDir = typeof filePath === "string" ? path.dirname(filePath) : null;
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

  // Provide Astro config if host is available
  try {
    const { getHost } = await import("../astro-host");
    const host = getHost();
    if (host) {
      context.config = host.config as unknown as Record<string, unknown>;
    }
  } catch {
    // No astro host — config stays empty
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
 * Build an `image()` factory bound to a specific entry directory.
 *
 * Accepted path forms:
 *  - Relative (`./logo.png`, `../assets/foo.png`) — resolved against the
 *    entry file's directory.
 *  - Root-absolute (`/uploads/foo.png`) — rejected; use plain `z.string()`
 *    for public/ assets.
 *  - Remote URLs (`https://...`) — rejected; use `z.string().url()`.
 *
 * `entryDir` is null for entries with no on-disk source file (function
 * loaders, etc.); image() issues a validation error in that case.
 */
function makeImageFactory(
  entryDir: string | null,
): () => z.ZodType<ImageMetadata, unknown> {
  return () =>
    z.string().transform(async (relPath: string, ctx: z.RefinementCtx) => {
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

      const fsPath = path.resolve(entryDir, relPath);
      try {
        const probe = await probeAndRegisterImage(fsPath);
        return makeImageMetadata({
          src: imageUrlFor(fsPath, probe.outputPath),
          width: probe.width,
          height: probe.height,
          format: probe.format,
          fsPath,
        });
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === "ENOENT") {
          return fail(`image not found: ${relPath} (resolved to ${fsPath})`);
        }
        return fail(`could not read image ${relPath}: ${err.message}`);
      }
    });
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
      resolved = schema({ image: makeImageFactory(entryDir) });
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
  const resolveForDir = makeSchemaResolver(config.schema);

  const outcomes = await Promise.all(
    rawEntries.map(async (raw): Promise<EntryOutcome> => {
      const { _html, _mdxFilePath, _filePath, ...userData } = raw.data;
      const entryDir = typeof _filePath === "string" ? path.dirname(_filePath) : null;
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
            const mod = await import(mdxPath + `?v=${configVersion}`);
            // Pass `components` so bare MDX element references (e.g. a
            // `<Youtube />` with no import) resolve, mirroring Astro's
            // `<Content components={...} />`.
            let rendered = mod.default(components ? { components } : {});
            if (rendered instanceof Promise) rendered = await rendered;
            let html = typeof rendered === "object" && rendered !== null && "__html" in rendered
              ? (rendered as { __html: string }).__html
              : String(rendered);
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

async function findContentConfigPath(projectRoot: string): Promise<string | null> {
  for (const candidate of CONTENT_CONFIG_CANDIDATES) {
    const configPath = path.join(projectRoot, candidate);
    if (await Bun.file(configPath).exists()) return configPath;
  }
  return null;
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
