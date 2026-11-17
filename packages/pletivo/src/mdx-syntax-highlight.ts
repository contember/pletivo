/**
 * Syntax highlighting for MDX in an Astro project, as `@astrojs/mdx` does it: Astro's own
 * `rehypeShiki` / `rehypePrism` from the `@astrojs/markdown-remark` the project's `astro` depends
 * on, so the output is Astro's byte for byte and pletivo carries no highlighter of its own.
 */
import path from "path";
import type { Pluggable, Plugin, Transformer } from "unified";

/** Astro's `markdown.syntaxHighlight`, parsed: `false` turns highlighting off. */
export type SyntaxHighlight = { type: "shiki" | "prism"; excludeLangs?: string[] } | false;

/** Astro's schema default: Shiki, with `math` blocks left alone. */
const SYNTAX_HIGHLIGHT_DEFAULT: SyntaxHighlight = { type: "shiki", excludeLangs: ["math"] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isHighlighterType(value: unknown): value is "shiki" | "prism" {
  return value === "shiki" || value === "prism";
}

/** Parse `syntaxHighlight` as Astro's config schema does, failing on what it rejects. */
export function parseSyntaxHighlight(value: unknown, source: string): SyntaxHighlight {
  if (value === undefined) return SYNTAX_HIGHLIGHT_DEFAULT;
  if (value === false) return false;
  if (isHighlighterType(value)) return { type: value };
  if (isRecord(value) && !Array.isArray(value)) {
    const type = value.type ?? "shiki";
    const excludeLangs = value.excludeLangs ?? ["math"];
    if (isHighlighterType(type) && Array.isArray(excludeLangs) && excludeLangs.every((lang) => typeof lang === "string")) {
      return { type, excludeLangs };
    }
  }
  throw new Error(
    `${source}.syntaxHighlight must be false, "shiki", "prism" or { type, excludeLangs }, got ${JSON.stringify(value)}`,
  );
}

/** `shikiConfig` goes to Astro's `rehypeShiki` as given; its fields are Shiki's to validate. */
export function parseShikiConfig(value: unknown, source: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (isRecord(value) && !Array.isArray(value)) return value;
  throw new Error(`${source}.shikiConfig must be an object, got ${JSON.stringify(value)}`);
}

interface AstroHighlighters {
  rehypeShiki: Plugin;
  rehypePrism: Plugin;
}

function isPlugin(value: unknown): value is Plugin {
  return typeof value === "function";
}

const loaded = new Map<string, Promise<AstroHighlighters>>();

async function loadAstroHighlighters(projectRoot: string): Promise<AstroHighlighters> {
  let astroDir: string;
  try {
    astroDir = path.dirname(Bun.resolveSync("astro/package.json", projectRoot));
  } catch (error) {
    throw new Error(`MDX syntax highlighting uses the project's astro package, which cannot be resolved from ${projectRoot}`, {
      cause: error,
    });
  }
  // From astro's own directory: an isolated install does not hoist astro's dependencies.
  let entry: string;
  try {
    entry = Bun.resolveSync("@astrojs/markdown-remark", astroDir);
  } catch (error) {
    throw new Error(
      `MDX syntax highlighting uses @astrojs/markdown-remark, which cannot be resolved from the project's astro at ${astroDir}`,
      { cause: error },
    );
  }
  const mod: unknown = await import(entry);
  const rehypeShiki = isRecord(mod) ? mod.rehypeShiki : undefined;
  const rehypePrism = isRecord(mod) ? mod.rehypePrism : undefined;
  if (!isPlugin(rehypeShiki) || !isPlugin(rehypePrism)) {
    throw new Error(`${entry} does not export rehypeShiki and rehypePrism`);
  }
  return { rehypeShiki, rehypePrism };
}

/** The highlighter plugin `@astrojs/mdx` puts after `rehype-raw`, or none. */
export async function astroHighlightPlugins(
  projectRoot: string,
  syntaxHighlight: SyntaxHighlight,
  shikiConfig: Record<string, unknown>,
): Promise<Pluggable[]> {
  if (!syntaxHighlight) return [];
  let highlighters = loaded.get(projectRoot);
  if (!highlighters) {
    highlighters = loadAstroHighlighters(projectRoot);
    loaded.set(projectRoot, highlighters);
  }
  const { rehypeShiki, rehypePrism } = await highlighters;
  return syntaxHighlight.type === "shiki"
    ? [[rehypeShiki, shikiConfig, syntaxHighlight.excludeLangs]]
    : [[rehypePrism, syntaxHighlight.excludeLangs]];
}

interface CodeElement {
  type: "element";
  tagName: "code";
  properties?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

function isCodeElement(node: unknown): node is CodeElement {
  return isRecord(node) && node.type === "element" && node.tagName === "code";
}

function visit(node: unknown, fn: (node: unknown) => void): void {
  fn(node);
  if (isRecord(node) && Array.isArray(node.children)) for (const child of node.children) visit(child, fn);
}

/**
 * Port of `@astrojs/mdx`'s `rehypeMetaString`: `rehype-raw` drops `data`, so a code fence's meta
 * (```js {1:3}) is kept as the `metastring` property for the highlighter.
 */
export function rehypeMdxMetaString(): Transformer {
  return (tree) => {
    visit(tree, (node) => {
      if (!isCodeElement(node) || !node.data?.meta) return;
      node.properties ??= {};
      node.properties.metastring = node.data.meta;
    });
  };
}
