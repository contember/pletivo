import path from "path";
import { Glob } from "bun";
import { z } from "zod";
import { parseMarkdown } from "./markdown";

// ── Types ──

export interface RawEntry {
  id: string;
  body: string;
  data: Record<string, unknown>;
}

export interface Loader {
  load(projectRoot: string): Promise<RawEntry[]>;
}

export interface CollectionConfig {
  /** Loader that provides raw entries. Use glob() for file-based collections. */
  loader?: Loader;
  /** Shorthand for loader: glob({ base: directory }) */
  directory?: string;
  /** Zod schema for frontmatter validation */
  schema: z.ZodType;
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
 */
export function glob(options: GlobOptions): Loader {
  return {
    async load(projectRoot: string): Promise<RawEntry[]> {
      const dir = path.resolve(projectRoot, options.base);
      const globPattern = new Glob(options.pattern ?? "**/*.md");
      const entries: RawEntry[] = [];

      for await (const file of globPattern.scan(dir)) {
        const fullPath = path.join(dir, file);
        const content = await Bun.file(fullPath).text();
        const parsed = parseMarkdown(content);
        const id = file.replace(/\.md$/, "").replace(/\//g, "-");

        entries.push({
          id,
          body: parsed.body,
          data: { ...parsed.frontmatter, _html: parsed.html },
        });
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

export async function initCollections(projectRoot: string): Promise<void> {
  configProjectRoot = projectRoot;
  collectionCache.clear();
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

export async function getEntry<T = Record<string, unknown>>(
  name: string,
  id: string,
): Promise<CollectionEntry<T> | undefined> {
  const entries = await getCollection<T>(name);
  return entries.find((e) => e.id === id);
}

// ── Internal ──

async function loadCollection(config: CollectionConfig, name: string): Promise<CollectionEntry[]> {
  if (!config.loader) {
    throw new Error(`Collection "${name}" has no loader. Use glob() or set directory.`);
  }

  const rawEntries = await config.loader.load(configProjectRoot);
  const entries: CollectionEntry[] = [];

  for (const raw of rawEntries) {
    // Separate internal _html from user data before validation
    const { _html, ...userData } = raw.data;

    const result = config.schema.safeParse(userData);
    if (!result.success) {
      const errors = result.error instanceof z.ZodError
        ? result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")
        : String(result.error);
      console.error(`Validation error in ${name}/${raw.id}:\n${errors}`);
      continue;
    }

    let html = (_html as string) ?? "";
    if (config.transform) {
      html = config.transform(html, result.data as Record<string, unknown>);
    }

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
