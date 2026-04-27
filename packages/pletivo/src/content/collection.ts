import path from "path";
import fs from "fs";
import { Glob } from "bun";
import { z } from "zod";
import yaml from "js-yaml";
import { parseMarkdown, parseFrontmatter } from "./markdown";
import {
  imageUrlFor,
  makeImageMetadata,
  probeAndRegisterImage,
  type ImageMetadata,
} from "../image";

// ── Types ──

export interface RawEntry {
  id: string;
  body: string;
  data: Record<string, unknown>;
}

/** Legacy pletivo loader — returns entries directly. */
export interface Loader {
  load(projectRoot: string): Promise<RawEntry[]>;
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
  render(): Promise<RenderResult>;
}

// ── Built-in loaders ──

export interface GlobOptions {
  /** Glob pattern (default: "**\/*.md") */
  pattern?: string;
  /** Base directory relative to project root */
  base: string;
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
  return {
    async load(projectRoot: string): Promise<RawEntry[]> {
      const dir = path.resolve(projectRoot, options.base);
      if (!fs.existsSync(dir)) return [];
      const globPattern = new Glob(options.pattern ?? "**/*.{md,mdx}");
      const entries: RawEntry[] = [];

      for await (const file of globPattern.scan(dir)) {
        const fullPath = path.join(dir, file);
        const content = await Bun.file(fullPath).text();
        const ext = path.extname(file).toLowerCase();
        // Astro parity: collection entry IDs preserve the subdirectory
        // structure under the collection root, so
        // `news/cs/praha-2.md` → `cs/praha-2`. Users rely on this for
        // dir-per-locale content (filter by `entry.id.startsWith("cs/")`)
        // and for nested dynamic routes.
        const id = file.replace(/\.(md|mdx|json|ya?ml)$/i, "");

        if (ext === ".json") {
          let data: Record<string, unknown>;
          try {
            data = JSON.parse(content);
          } catch (e) {
            console.error(`  JSON parse error in ${file}: ${(e as Error).message}`);
            continue;
          }
          entries.push({ id, body: "", data: { ...data, _filePath: fullPath } });
        } else if (ext === ".yaml" || ext === ".yml") {
          let data: Record<string, unknown>;
          try {
            const parsed = yaml.load(content);
            data = (parsed && typeof parsed === "object" && !Array.isArray(parsed))
              ? parsed as Record<string, unknown>
              : {};
          } catch (e) {
            console.error(`  YAML parse error in ${file}: ${(e as Error).message}`);
            continue;
          }
          entries.push({ id, body: "", data: { ...data, _filePath: fullPath } });
        } else if (ext === ".mdx") {
          // .mdx — parse frontmatter for validation, defer rendering to import time
          const { frontmatter, body } = parseFrontmatter(content);
          entries.push({
            id,
            body,
            data: { ...frontmatter, _filePath: fullPath, _mdxFilePath: fullPath },
          });
        } else {
          // .md
          const parsed = parseMarkdown(content);
          entries.push({
            id,
            body: parsed.body,
            data: { ...parsed.frontmatter, _filePath: fullPath, _html: parsed.html },
          });
        }
      }

      return entries;
    },
  };
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

export async function initCollections(projectRoot: string): Promise<void> {
  configProjectRoot = projectRoot;
  collectionCache.clear();
  validationFailures.length = 0;
  configVersion++;

  const configPath = path.join(projectRoot, "src/content.config.ts");
  const configFile = Bun.file(configPath);

  if (await configFile.exists()) {
    const mod = await import(configPath + `?v=${configVersion}`);
    collectionsConfig = mod.collections || {};
  } else {
    collectionsConfig = {};
  }
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
    throw new Error(`Collection "${name}" not found. Define it in src/content.config.ts`);
  }

  if (!collectionCache.has(name)) {
    const entries = await loadCollection(config, name);
    collectionCache.set(name, entries);
  }
  let entries = collectionCache.get(name)! as CollectionEntry<T>[];
  if (filter) {
    entries = entries.filter(filter);
  }
  return entries;
}

/**
 * Astro-compatible `render(entry)` helper. Returns `{ Content }` where
 * `Content` is a component that emits the entry's pre-rendered HTML body.
 *
 * MDX entries are compiled and rendered with full component support — imports
 * in the MDX body (both JSX and .astro components) are resolved at render time.
 */
export async function render(
  entry: CollectionEntry | null | undefined,
): Promise<{ Content: () => { __html: string }; headings: unknown[]; remarkPluginFrontmatter: Record<string, unknown> }> {
  const result = entry ? await entry.render() : { html: "" };
  const Content = () => ({ __html: result.html });
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

  return buildEntries(rawEntries, config, name);
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

  const context: LoaderContext = {
    collection: name,
    store,
    meta,
    logger,
    config: {},
    async parseData<T>({ id, data }: { id: string; data: T }): Promise<T> {
      const filePath = (data as Record<string, unknown>)?._filePath;
      const entryDir = typeof filePath === "string" ? path.dirname(filePath) : null;
      const schema = resolveSchema(schemaSpec, entryDir);
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
      if (!fs.existsSync(fsPath)) {
        return fail(`image not found: ${relPath} (resolved to ${fsPath})`);
      }
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
        return fail(`could not read image ${relPath}: ${(e as Error).message}`);
      }
    });
}

/**
 * Resolve a CollectionConfig.schema (static or function form) to a
 * concrete Zod schema for a given entry directory. The function form
 * gets a fresh `image()` factory bound to that directory.
 */
function resolveSchema(
  schema: z.ZodType | SchemaFn,
  entryDir: string | null,
): z.ZodType {
  if (typeof schema === "function") {
    return schema({ image: makeImageFactory(entryDir) });
  }
  return schema;
}

/** Validate raw entries against the schema and build CollectionEntry objects. */
async function buildEntries(rawEntries: RawEntry[], config: CollectionConfig, name: string): Promise<CollectionEntry[]> {
  const entries: CollectionEntry[] = [];

  for (const raw of rawEntries) {
    const { _html, _mdxFilePath, _filePath, ...userData } = raw.data;
    const entryDir = typeof _filePath === "string" ? path.dirname(_filePath) : null;
    const schema = resolveSchema(config.schema, entryDir);
    const result = await schema.safeParseAsync(userData);
    if (!result.success) {
      const errors = result.error instanceof z.ZodError
        ? result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")
        : String(result.error);
      console.error(`Validation error in ${name}/${raw.id}:\n${errors}`);
      validationFailures.push({ collection: name, id: raw.id, errors });
      continue;
    }

    if (_mdxFilePath) {
      const mdxPath = _mdxFilePath as string;
      const validatedData = result.data as Record<string, unknown>;
      entries.push({
        id: raw.id,
        data: validatedData,
        body: raw.body,
        render: async () => {
          const mod = await import(mdxPath + `?v=${configVersion}`);
          let rendered = mod.default({});
          if (rendered instanceof Promise) rendered = await rendered;
          let html = typeof rendered === "object" && rendered !== null && "__html" in rendered
            ? (rendered as { __html: string }).__html
            : String(rendered);
          if (config.transform) html = config.transform(html, validatedData);
          return { html };
        },
      });
      continue;
    }

    let html = (_html as string) ?? "";
    if (config.transform) html = config.transform(html, result.data as Record<string, unknown>);
    entries.push({
      id: raw.id,
      data: result.data as Record<string, unknown>,
      body: raw.body,
      render: async () => ({ html }),
    });
  }

  return entries;
}

export { z } from "zod";
