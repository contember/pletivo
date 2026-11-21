/**
 * Syntax highlighting for MDX in an Astro project, as `@astrojs/mdx` does it: Astro's own
 * `rehypeShiki` / `rehypePrism` from the `@astrojs/markdown-remark` the project's `astro` depends
 * on, so the output is Astro's byte for byte and pletivo carries no highlighter of its own.
 */
import path from "path";
import type { Pluggable, Transformer } from "unified";

/** Astro's `markdown.syntaxHighlight`, parsed: `false` turns highlighting off. */
export type SyntaxHighlight = { type: "shiki" | "prism"; excludeLangs?: string[] } | false;

/** The `shikiConfig` fields Astro's `rehypeShiki` reads, checked against Astro's schema. */
export type ShikiConfig = Record<string, unknown>;

/** What picks and configures the highlighter. One per resolved config: it owns one highlighter. */
export interface AstroHighlight {
  /** What the highlighter renders, as its warnings name it. */
  subject: "MDX" | "Markdown";
  /** The project root, absolute: Astro's highlighters load from its `astro`. */
  projectRoot: string;
  syntaxHighlight: SyntaxHighlight;
  shikiConfig: ShikiConfig;
}

/** Astro's schema default: Shiki, with `math` blocks left alone. */
export const SYNTAX_HIGHLIGHT_DEFAULT: SyntaxHighlight = { type: "shiki", excludeLangs: ["math"] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHighlighterType(value: unknown): value is "shiki" | "prism" {
  return value === "shiki" || value === "prism";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function syntaxHighlightError(value: unknown, source: string): Error {
  return new Error(
    `${source}.syntaxHighlight must be false, "shiki", "prism" or { type, excludeLangs }, got ${JSON.stringify(value)}`,
  );
}

/** Parse `markdown.syntaxHighlight` as Astro's config schema does, defaults included. */
export function parseSyntaxHighlight(value: unknown, source: string): SyntaxHighlight {
  if (value === undefined) return SYNTAX_HIGHLIGHT_DEFAULT;
  if (value === false) return false;
  if (isHighlighterType(value)) return { type: value };
  if (isRecord(value)) {
    const type = value.type === undefined ? "shiki" : value.type;
    const excludeLangs = value.excludeLangs === undefined ? ["math"] : value.excludeLangs;
    if (isHighlighterType(type) && isStringArray(excludeLangs)) return { type, excludeLangs };
  }
  throw syntaxHighlightError(value, source);
}

/**
 * Parse `mdx({ syntaxHighlight })`, which `@astrojs/mdx` uses unvalidated and without defaults:
 * `undefined` defers to the markdown config, and an object's `excludeLangs` stays unset.
 */
export function parseMdxSyntaxHighlight(value: unknown, source: string): SyntaxHighlight | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === false) return false;
  if (isHighlighterType(value)) return { type: value };
  if (isRecord(value) && isHighlighterType(value.type)) {
    if (value.excludeLangs === undefined) return { type: value.type };
    if (isStringArray(value.excludeLangs)) return { type: value.type, excludeLangs: value.excludeLangs };
  }
  throw syntaxHighlightError(value, source);
}

function checkShikiConfig(value: unknown, source: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${source}.shikiConfig must be an object, got ${JSON.stringify(value)}`);
  const field = (key: string, valid: (field: unknown) => boolean, expected: string): void => {
    if (value[key] !== undefined && !valid(value[key])) {
      throw new Error(`${source}.shikiConfig.${key} must be ${expected}, got ${JSON.stringify(value[key])}`);
    }
  };
  field("langs", Array.isArray, "an array");
  field("langAlias", (alias) => isRecord(alias) && Object.values(alias).every((to) => typeof to === "string"), "an object of strings");
  field("themes", isRecord, "an object");
  field("defaultColor", (color) => typeof color === "string" || color === false, "a string or false");
  field("wrap", (wrap) => typeof wrap === "boolean" || wrap === null, "a boolean or null");
  field("transformers", Array.isArray, "an array");
  return value;
}

const SHIKI_CONFIG_KEYS = ["langs", "langAlias", "theme", "themes", "defaultColor", "wrap", "transformers"];

function pickShikiConfig(value: Record<string, unknown>, langs: unknown): ShikiConfig {
  const picked: ShikiConfig = {};
  for (const key of SHIKI_CONFIG_KEYS) if (value[key] !== undefined) picked[key] = value[key];
  if (langs !== undefined) picked.langs = langs;
  return picked;
}

/** Shiki 1 renamed a language's `id` to `name` and flattened `grammar` into it; Astro's schema ports both. */
function shikiCompatLang(lang: unknown): unknown {
  if (!isRecord(lang)) return lang;
  const { id, grammar } = lang;
  if (!id && !isRecord(grammar)) return lang;
  return { ...lang, ...(id ? { name: id } : {}), ...(isRecord(grammar) ? grammar : {}) };
}

/** Parse `markdown.shikiConfig` as Astro's config schema does, the `langs` transform included. */
export function parseShikiConfig(value: unknown, source: string): ShikiConfig {
  if (value === undefined) return {};
  const config = checkShikiConfig(value, source);
  return pickShikiConfig(config, Array.isArray(config.langs) ? config.langs.map(shikiCompatLang) : undefined);
}

/** Parse `mdx({ shikiConfig })`: the same fields, but `@astrojs/mdx` passes it on untransformed. */
export function parseMdxShikiConfig(value: unknown, source: string): ShikiConfig | undefined {
  if (value === undefined || value === null) return undefined;
  const config = checkShikiConfig(value, source);
  return pickShikiConfig(config, undefined);
}

type Attacher = (...options: unknown[]) => unknown;

function isFunction(value: unknown): value is Attacher {
  return typeof value === "function";
}

function isTransformer(value: unknown): value is Transformer {
  return typeof value === "function";
}

/** `@astrojs/markdown-remark` as the project's `astro` resolves it, or why it cannot be. */
export function resolveAstroMarkdownRemark(projectRoot: string): { entry: string } | { missing: "astro" | "@astrojs/markdown-remark"; reason: string } {
  let astroDir: string;
  try {
    astroDir = path.dirname(Bun.resolveSync("astro/package.json", projectRoot));
  } catch {
    return { missing: "astro", reason: `\`astro\` cannot be resolved from ${projectRoot}` };
  }
  // From astro's own directory: an isolated install does not hoist astro's dependencies.
  try {
    return { entry: Bun.resolveSync("@astrojs/markdown-remark", astroDir) };
  } catch {
    return {
      missing: "@astrojs/markdown-remark",
      reason: `\`@astrojs/markdown-remark\` cannot be resolved from the project's astro at ${astroDir}`,
    };
  }
}

/**
 * Without `astro` (pletivo's own `astro/config` stands in) or Astro 7's optional
 * `@astrojs/markdown-remark`, code blocks render unhighlighted, as before Astro's highlighters were used.
 */
function warnUnhighlighted(subject: AstroHighlight["subject"], missing: "astro" | "@astrojs/markdown-remark", reason: string): null {
  const config = subject === "MDX" ? "in `markdown` or in `mdx()`" : "in `markdown`";
  console.warn(
    `${subject} code blocks are not highlighted: ${reason}. ` +
      `Install \`${missing}\`, or set \`syntaxHighlight: false\` ${config} to silence this warning.`,
  );
  return null;
}

async function loadAstroHighlighter(
  subject: AstroHighlight["subject"],
  projectRoot: string,
  name: "rehypeShiki" | "rehypePrism",
): Promise<Attacher | null> {
  const resolved = resolveAstroMarkdownRemark(projectRoot);
  if ("missing" in resolved) return warnUnhighlighted(subject, resolved.missing, resolved.reason);
  const mod: unknown = await import(resolved.entry);
  const attacher = isRecord(mod) ? mod[name] : undefined;
  if (!isFunction(attacher)) {
    return warnUnhighlighted(subject, "@astrojs/markdown-remark", `\`@astrojs/markdown-remark\` at ${resolved.entry} does not export ${name}`);
  }
  return attacher;
}

async function createHighlighter({ subject, projectRoot, syntaxHighlight, shikiConfig }: AstroHighlight): Promise<Transformer | null> {
  if (!syntaxHighlight) return null;
  const attacher = await loadAstroHighlighter(subject, projectRoot, syntaxHighlight.type === "shiki" ? "rehypeShiki" : "rehypePrism");
  if (!attacher) return null;
  const transformer =
    syntaxHighlight.type === "shiki" ? attacher(shikiConfig, syntaxHighlight.excludeLangs) : attacher(syntaxHighlight.excludeLangs);
  if (!isTransformer(transformer)) throw new Error(`Astro's ${syntaxHighlight.type} highlighter did not return a transformer`);
  return transformer;
}

// Astro's attacher creates its Shiki highlighter on first use, so attaching once per compile would
// create one per MDX file. One transformer per resolved config, shared by every compile.
const highlighters = new WeakMap<AstroHighlight, Promise<Transformer | null>>();

/** The highlighter plugin `@astrojs/mdx` puts after `rehype-raw`, or none. */
export async function astroHighlightPlugins(highlight: AstroHighlight): Promise<Pluggable[]> {
  let created = highlighters.get(highlight);
  if (!created) {
    created = createHighlighter(highlight);
    highlighters.set(highlight, created);
  }
  const transformer = await created;
  return transformer ? [() => transformer] : [];
}
