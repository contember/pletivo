import path from "path";
import { Glob } from "bun";
import { z } from "zod";
import { parseMarkdown } from "./markdown";

export interface CollectionConfig {
  directory: string;
  schema: z.ZodType;
}

export interface CollectionEntry<T = Record<string, unknown>> {
  id: string;
  data: T;
  body: string;
  html: string;
}

/**
 * Define a content collection with schema validation
 */
export function defineCollection(config: CollectionConfig): CollectionConfig {
  return config;
}

// Cache for loaded collections
const collectionCache = new Map<string, CollectionEntry[]>();

// Registered collections config (loaded from user's content.config.ts)
let collectionsConfig: Record<string, CollectionConfig> | null = null;
let configProjectRoot: string = "";
let configVersion = 0;

/**
 * Initialize collections from the project's content.config.ts.
 * Busts Bun's module cache via query string to pick up changes in dev.
 */
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

/**
 * Get all entries from a collection, with optional filter
 */
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

  // Check cache
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
 * Get a single entry by ID
 */
export async function getEntry<T = Record<string, unknown>>(
  name: string,
  id: string,
): Promise<CollectionEntry<T> | undefined> {
  const entries = await getCollection<T>(name);
  return entries.find((e) => e.id === id);
}

/**
 * Load all entries from a collection directory
 */
async function loadCollection(config: CollectionConfig, name: string): Promise<CollectionEntry[]> {
  const dir = path.resolve(configProjectRoot, config.directory);
  const glob = new Glob("**/*.md");
  const entries: CollectionEntry[] = [];

  for await (const file of glob.scan(dir)) {
    const fullPath = path.join(dir, file);
    const content = await Bun.file(fullPath).text();
    const parsed = parseMarkdown(content);

    // Validate with schema
    const result = config.schema.safeParse(parsed.frontmatter);
    if (!result.success) {
      const errors = result.error instanceof z.ZodError
        ? result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")
        : String(result.error);
      console.error(`Validation error in ${name}/${file}:\n${errors}`);
      continue;
    }

    const id = file.replace(/\.md$/, "").replace(/\//g, "-");

    entries.push({
      id,
      data: result.data as Record<string, unknown>,
      body: parsed.body,
      html: parsed.html,
    });
  }

  return entries;
}

// Re-export z for user convenience
export { z } from "zod";
