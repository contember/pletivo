/**
 * Markdown rendering for `.md` content, built on the unified/remark pipeline
 * so user-configured remark/rehype plugins actually run (Astro parity):
 *
 *   remark-parse → [remark-gfm] → remarkPlugins → remark-rehype
 *     → heading-id slugs → rehypePlugins → rehype-raw → rehype-stringify
 *
 * Plugins come from the Astro config's top-level `markdown` options and are
 * installed once via `configureMarkdown()` (see dev.ts / build.ts) before any
 * `.md` is rendered. `.mdx` is handled separately by mdx-plugin.ts.
 */

import yaml from "js-yaml";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeRaw from "rehype-raw";
import rehypeStringify from "rehype-stringify";
import type { CompileOptions } from "@mdx-js/mdx";

// `unified`'s `PluggableList` — derived from the published `CompileOptions`
// (the bare `unified` specifier isn't directly resolvable here; see config.ts).
type PluggableList = NonNullable<CompileOptions["remarkPlugins"]>;

export interface ParsedMarkdown {
  frontmatter: Record<string, unknown>;
  body: string;
  html: string;
}

export interface MarkdownOptions {
  remarkPlugins?: PluggableList;
  rehypePlugins?: PluggableList;
  /** Options forwarded to `remark-rehype` (e.g. `allowDangerousHtml`). */
  remarkRehype?: Record<string, unknown>;
  /** GitHub Flavored Markdown — on by default, matching Astro. */
  gfm?: boolean;
}

let markdownOptions: MarkdownOptions = {};

/** Install the markdown plugin set used by `parseMarkdown`. */
export function configureMarkdown(options: MarkdownOptions): void {
  markdownOptions = options;
}

/** The keys of an Astro `markdown` config that pletivo renders with. */
export interface AstroMarkdownSettings {
  remarkPlugins?: PluggableList;
  rehypePlugins?: PluggableList;
  remarkRehype?: Record<string, unknown>;
  gfm?: boolean;
}

export interface AstroMarkdownConfig extends AstroMarkdownSettings {
  /** Astro 7: `unified({...})` from `@astrojs/markdown-remark` carries its settings in `options`. */
  processor?: { name: string; options?: AstroMarkdownSettings };
  /** Unparsed: MDX parses them as Astro's schema does (`mdx-syntax-highlight.ts`). */
  syntaxHighlight?: unknown;
  shikiConfig?: unknown;
}

/**
 * What Astro 7 renders `.md`/`.mdx` with: a `unified()` processor's plugins, then the deprecated top-level ones,
 * whose `remarkRehype` keys override the processor's. Under another processor Astro skips the top level;
 * pletivo keeps rendering it, as it did before processors existed.
 */
export function astroMarkdownSettings(
  astroConfig?: { markdown?: AstroMarkdownConfig; [key: string]: unknown } | null,
): AstroMarkdownSettings | undefined {
  const md = astroConfig?.markdown;
  const unified = md?.processor?.name === "unified" ? md.processor.options : undefined;
  if (!md || !unified) return md;
  return {
    remarkPlugins: [...(unified.remarkPlugins ?? []), ...(md.remarkPlugins ?? [])],
    rehypePlugins: [...(unified.rehypePlugins ?? []), ...(md.rehypePlugins ?? [])],
    remarkRehype: { ...unified.remarkRehype, ...md.remarkRehype },
    gfm: unified.gfm ?? md.gfm,
  };
}

/**
 * Extract the `markdown` plugin config from an Astro config (see astroMarkdownSettings).
 * The `mdx()` integration plugins are MDX-only, handled by resolveMdxOptions.
 */
export function resolveMarkdownOptions(
  astroConfig?: { markdown?: AstroMarkdownConfig; [key: string]: unknown } | null,
): MarkdownOptions {
  const md = astroMarkdownSettings(astroConfig);
  return {
    remarkPlugins: md?.remarkPlugins ?? [],
    rehypePlugins: md?.rehypePlugins ?? [],
    remarkRehype: md?.remarkRehype ?? {},
    gfm: md?.gfm ?? true,
  };
}

/**
 * Parse a YAML string and narrow it to a plain object — anything else
 * (string, array, null) becomes `{}`. Uses js-yaml's default schema so
 * ISO timestamps parse to Date objects, matching Astro's frontmatter
 * behavior.
 */
export function parseYamlObject(input: string): Record<string, unknown> {
  const parsed = yaml.load(input);
  return (parsed && typeof parsed === "object" && !Array.isArray(parsed))
    ? parsed as Record<string, unknown>
    : {};
}

/** Split off a YAML frontmatter block without parsing it. `yaml` is null when there is none. */
export function splitFrontmatter(content: string): { yaml: string | null; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return { yaml: null, body: content };
  }
  return { yaml: match[1], body: match[2] };
}

export function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const { yaml, body } = splitFrontmatter(content);
  return { frontmatter: yaml === null ? {} : parseYamlObject(yaml), body };
}

/**
 * GitHub-style heading slugifier.
 * Lowercases, strips inline HTML tags, keeps alphanumerics + dashes,
 * collapses whitespace to single dashes.
 */
function slugify(text: string): string {
  return text
    .replace(/<[^>]+>/g, "") // strip any embedded HTML
    .toLowerCase()
    .trim()
    .replace(/[^\p{Letter}\p{Number}\s-]+/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Produce a unique slug within a single document (GitHub-style: suffix -1, -2…) */
function uniqueSlug(base: string, seen: Map<string, number>): string {
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

/** Concatenate the text content of a hast node subtree. */
function hastTextContent(node: any): string {
  if (node.type === "text") return typeof node.value === "string" ? node.value : "";
  return (node.children ?? []).map(hastTextContent).join("");
}

/**
 * Rehype plugin: give every heading a GitHub-style `id` (unique per document),
 * preserving pletivo's prior heading-anchor behavior. Skips headings that
 * already carry an explicit id.
 */
function rehypeHeadingIds() {
  return (tree: any) => {
    const seen = new Map<string, number>();
    const visit = (node: any) => {
      if (node?.type === "element" && /^h[1-6]$/.test(node.tagName)) {
        // Skip headings with no sluggable text (e.g. a bare `#`) — they'd
        // otherwise pick up a meaningless uniquified id like `-1`.
        const base = slugify(hastTextContent(node));
        if (base) {
          node.properties = node.properties ?? {};
          if (node.properties.id == null) node.properties.id = uniqueSlug(base, seen);
        }
      }
      (node?.children ?? []).forEach(visit);
    };
    visit(tree);
  };
}

/**
 * Render a markdown body (frontmatter already stripped) to HTML, running the
 * configured remark/rehype plugins. A fresh processor is built per call so
 * plugin config changes take effect and processors are never reused frozen.
 */
export async function renderMarkdown(body: string): Promise<string> {
  const processor = unified().use(remarkParse);
  if (markdownOptions.gfm !== false) processor.use(remarkGfm);
  if (markdownOptions.remarkPlugins?.length) processor.use(markdownOptions.remarkPlugins);
  processor.use(remarkRehype, { allowDangerousHtml: true, ...markdownOptions.remarkRehype });
  processor.use(rehypeHeadingIds);
  if (markdownOptions.rehypePlugins?.length) processor.use(markdownOptions.rehypePlugins);
  // Last, as in Astro: raw HTML is re-serialized like the rest (`<a\n href>` → `<a href>`).
  processor.use(rehypeRaw);
  processor.use(rehypeStringify, { allowDangerousHtml: true });

  const file = await processor.process(body.trim());
  return String(file);
}

/**
 * Parse a markdown file's content into frontmatter + rendered HTML. Kept for
 * callers that need both up front; the content-collection loader parses
 * frontmatter eagerly and defers `renderMarkdown` to `entry.render()`.
 */
export async function parseMarkdown(content: string): Promise<ParsedMarkdown> {
  const { frontmatter, body } = parseFrontmatter(content);
  const html = await renderMarkdown(body);
  return { frontmatter, body, html };
}

/**
 * Why a `.md`/`.mdx` *page* at `file` cannot render, or null. No host applies `layout:`
 * yet, and rendering without it ships the page without its layout's `<head>` and shell.
 * Content-collection entries never come through here: their `layout` is plain data.
 */
export function markdownPageLayoutReason(file: string, frontmatter: Record<string, unknown>): string | null {
  if (!frontmatter.layout) return null;
  const wrap = file.endsWith(".mdx") ? ", import the layout and wrap the content in it," : "";
  return (
    "`layout:` in frontmatter is not supported by pletivo yet; the page would render without its layout. " +
    `Render the content from an .astro page that uses the layout${wrap} or remove \`layout:\``
  );
}
