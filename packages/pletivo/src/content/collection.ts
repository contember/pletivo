import path from "path";
import fs from "fs";
import { Glob } from "bun";
import { z } from "zod";
import { parseMarkdown, parseFrontmatter } from "./markdown";

// ── Types ──

export interface RawEntry {
  id: string;
  body: string;
  data: Record<string, unknown>;
}

export interface Loader {
  load(projectRoot: string): Promise<RawEntry[]>;
}

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
          entries.push({ id, body: "", data });
        } else if (ext === ".yaml" || ext === ".yml") {
          const data = parseSimpleYaml(content);
          entries.push({ id, body: "", data });
        } else if (ext === ".mdx") {
          // .mdx — parse frontmatter for validation, defer rendering to import time
          const { frontmatter, body } = parseFrontmatter(content);
          entries.push({
            id,
            body,
            data: { ...frontmatter, _mdxFilePath: fullPath },
          });
        } else {
          // .md
          const parsed = parseMarkdown(content);
          entries.push({
            id,
            body: parsed.body,
            data: { ...parsed.frontmatter, _html: parsed.html },
          });
        }
      }

      return entries;
    },
  };
}

/**
 * Minimal YAML subset parser for content frontmatter. Supports scalars,
 * nested maps, sequences of scalars/maps, and quoted strings. Complex
 * features (anchors, multiline strings, flow mappings) are not supported —
 * convert to JSON for those.
 */
function parseSimpleYaml(input: string): Record<string, unknown> {
  interface Line {
    indent: number;
    text: string;
  }
  const rawLines = input.split(/\r?\n/);
  const lines: Line[] = [];
  for (const l of rawLines) {
    if (/^\s*#/.test(l) || l.trim() === "") continue;
    const indent = l.match(/^\s*/)![0].length;
    lines.push({ indent, text: l.slice(indent) });
  }

  const coerce = (raw: string): unknown => {
    const s = raw.trim();
    if (s === "" || s === "null" || s === "~") return null;
    if (s === "true") return true;
    if (s === "false") return false;
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      return s.slice(1, -1);
    }
    return s;
  };

  let i = 0;
  const parseBlock = (parentIndent: number): unknown => {
    // Determine if this block is a sequence or a mapping
    if (i >= lines.length) return {};
    const first = lines[i];
    if (first.text.startsWith("- ") || first.text === "-") {
      // Sequence
      const arr: unknown[] = [];
      const blockIndent = first.indent;
      while (i < lines.length && lines[i].indent === blockIndent && (lines[i].text.startsWith("- ") || lines[i].text === "-")) {
        const itemText = lines[i].text === "-" ? "" : lines[i].text.slice(2);
        if (itemText === "") {
          i++;
          arr.push(parseBlock(blockIndent));
          continue;
        }
        const kv = itemText.match(/^([\w.-]+):\s*(.*)$/);
        if (kv) {
          // Inline map item: `- key: value` (possibly followed by more keys at deeper indent)
          const obj: Record<string, unknown> = {};
          if (kv[2] !== "") {
            obj[kv[1]] = coerce(kv[2]);
            i++;
          } else {
            i++;
            if (i < lines.length && lines[i].indent > blockIndent) {
              obj[kv[1]] = parseBlock(lines[i].indent);
            } else {
              obj[kv[1]] = null;
            }
          }
          // Collect additional sibling keys at (blockIndent + 2)
          while (
            i < lines.length &&
            lines[i].indent === blockIndent + 2 &&
            !lines[i].text.startsWith("- ")
          ) {
            const more = lines[i].text.match(/^([\w.-]+):\s*(.*)$/);
            if (!more) break;
            if (more[2] !== "") {
              obj[more[1]] = coerce(more[2]);
              i++;
            } else {
              i++;
              if (i < lines.length && lines[i].indent > blockIndent + 2) {
                obj[more[1]] = parseBlock(lines[i].indent);
              } else {
                obj[more[1]] = null;
              }
            }
          }
          arr.push(obj);
        } else {
          arr.push(coerce(itemText));
          i++;
        }
      }
      return arr;
    }
    // Mapping
    const obj: Record<string, unknown> = {};
    const blockIndent = first.indent;
    while (i < lines.length && lines[i].indent === blockIndent) {
      const text = lines[i].text;
      if (text.startsWith("- ")) break;
      const kv = text.match(/^([\w.-]+):\s*(.*)$/);
      if (!kv) {
        i++;
        continue;
      }
      const [, key, value] = kv;
      if (value === "") {
        i++;
        if (i < lines.length && lines[i].indent > blockIndent) {
          obj[key] = parseBlock(lines[i].indent);
        } else {
          obj[key] = null;
        }
      } else if (value === "[]") {
        obj[key] = [];
        i++;
      } else if (value === "{}") {
        obj[key] = {};
        i++;
      } else {
        obj[key] = coerce(value);
        i++;
      }
    }
    return obj;
  };

  const result = parseBlock(-1);
  return (result && typeof result === "object" && !Array.isArray(result))
    ? (result as Record<string, unknown>)
    : {};
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

async function loadCollection(config: CollectionConfig, name: string): Promise<CollectionEntry[]> {
  if (!config.loader) {
    throw new Error(`Collection "${name}" has no loader. Use glob() or set directory.`);
  }

  const rawEntries = await config.loader.load(configProjectRoot);
  const entries: CollectionEntry[] = [];

  for (const raw of rawEntries) {
    // Separate internal fields from user data before validation
    const { _html, _mdxFilePath, ...userData } = raw.data;

    const result = config.schema.safeParse(userData);
    if (!result.success) {
      const errors = result.error instanceof z.ZodError
        ? result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")
        : String(result.error);
      console.error(`Validation error in ${name}/${raw.id}:\n${errors}`);
      continue;
    }

    if (_mdxFilePath) {
      // MDX: render by importing the compiled module and calling its default export
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
          if (config.transform) {
            html = config.transform(html, validatedData);
          }
          return { html };
        },
      });
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
