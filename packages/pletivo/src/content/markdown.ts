/**
 * Markdown rendering for `.md` content.
 *
 * Two engines, picked per render in `parseMarkdown`:
 *
 *  1. Sätteri (default) — the native Rust GFM engine Astro 7 itself uses, so
 *     output matches Astro. Used for the common case (no user remark/rehype
 *     plugins) because it is ~30-40x faster than unified and removes pletivo's
 *     markdown scaling bottleneck on large sites.
 *
 *  2. unified/remark (fallback) — used when the Astro config sets any
 *     `markdown.remarkPlugins` / `markdown.rehypePlugins` (or `remarkRehype`
 *     options), because those plugins are remark/rehype-specific and cannot run
 *     on Sätteri. Preserves the Astro plugin-compat promise:
 *
 *       remark-parse → [remark-gfm] → remarkPlugins → remark-rehype
 *         → heading-id slugs → rehypePlugins → rehype-stringify
 *
 * Both paths share the same heading-id slug algorithm (`slugify` + per-document
 * `-1/-2` dedup), so heading anchors are identical regardless of engine.
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
import rehypeStringify from "rehype-stringify";
import { markdownToHtml, defineHastPlugin } from "satteri";
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

/**
 * Extract the top-level `markdown` plugin config from an Astro config. `.md`
 * files mirror Astro: they get `markdown.remarkPlugins` / `markdown.rehypePlugins`
 * (the `mdx()` integration plugins are MDX-only, handled by resolveMdxOptions).
 */
export function resolveMarkdownOptions(
  astroConfig?: {
    markdown?: {
      remarkPlugins?: PluggableList;
      rehypePlugins?: PluggableList;
      remarkRehype?: Record<string, unknown>;
      gfm?: boolean;
    };
    [key: string]: unknown;
  } | null,
): MarkdownOptions {
  const md = astroConfig?.markdown;
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

export function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }
  return { frontmatter: parseYamlObject(match[1]), body: match[2] };
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
 * Sätteri heading-id plugin: give every heading a unique-per-document id using
 * pletivo's `slugify` + `uniqueSlug`, matching the unified `rehypeHeadingIds`
 * plugin byte-for-byte. A fresh `seen` map is created per call (one per
 * document), so this must be instantiated per render.
 */
function satteriHeadingIds() {
  const seen = new Map<string, number>();
  return defineHastPlugin({
    name: "heading-ids",
    element: {
      filter: ["h1", "h2", "h3", "h4", "h5", "h6"],
      visit(node, ctx) {
        if (node.properties?.id != null) return;
        const base = slugify(ctx.textContent(node));
        if (base) ctx.setProperty(node, "id", uniqueSlug(base, seen));
      },
    },
  });
}

/** True when the user configured remark/rehype plugins that only unified can run. */
function hasUserPlugins(o: MarkdownOptions): boolean {
  return Boolean(
    o.remarkPlugins?.length ||
      o.rehypePlugins?.length ||
      (o.remarkRehype && Object.keys(o.remarkRehype).length),
  );
}

/** Fast path: render via Sätteri (native). Used when no user plugins are configured. */
async function renderMarkdownSatteri(body: string): Promise<string> {
  const { html } = await markdownToHtml(body.trim(), {
    features: { gfm: markdownOptions.gfm !== false, frontmatter: false },
    hastPlugins: [satteriHeadingIds()],
  });
  // Sätteri appends a single document-final newline; unified does not. Drop it
  // so output stays byte-identical to the unified path (and to prior pletivo).
  return html.replace(/\n$/, "");
}

/**
 * Compatibility path: the full unified/remark pipeline, so user-configured
 * remark/rehype plugins run. A fresh processor is built per call so plugin
 * config changes take effect and processors are never reused frozen.
 */
async function renderMarkdownUnified(body: string): Promise<string> {
  const processor = unified().use(remarkParse);
  if (markdownOptions.gfm !== false) processor.use(remarkGfm);
  if (markdownOptions.remarkPlugins?.length) processor.use(markdownOptions.remarkPlugins);
  processor.use(remarkRehype, { allowDangerousHtml: true, ...markdownOptions.remarkRehype });
  processor.use(rehypeHeadingIds);
  if (markdownOptions.rehypePlugins?.length) processor.use(markdownOptions.rehypePlugins);
  processor.use(rehypeStringify, { allowDangerousHtml: true });

  const file = await processor.process(body.trim());
  return String(file);
}

/**
 * Render a markdown body (frontmatter already stripped) to HTML. Renders via
 * Sätteri by default, falling back to the unified pipeline when the user has
 * configured remark/rehype plugins (see module header). Exported so the
 * content-collection loader can defer rendering to `entry.render()`.
 */
export async function renderMarkdown(body: string): Promise<string> {
  return hasUserPlugins(markdownOptions)
    ? renderMarkdownUnified(body)
    : renderMarkdownSatteri(body);
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
