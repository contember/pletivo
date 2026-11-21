/**
 * A `.md` file as a JavaScript module, as Astro's `vite-plugin-markdown` makes one:
 * `frontmatter`, `file`, `url`, `rawContent`, `compiledContent`, `getHeadings`,
 * `Content` and a default export. A `layout:` in the frontmatter is imported and the
 * content renders inside it. Both hosts compile `.md` through here; each names the
 * modules the generated code imports its helpers from.
 */

import path from "node:path";
import { parseFrontmatter } from "./markdown";

export interface MarkdownModuleOptions {
  /** The file's full text, frontmatter included. */
  source: string;
  /** The file's path, in the same form as `root`. The `file` export, and what `layout:` resolves from. */
  file: string;
  /** How an error names the file: its project-relative path. */
  label: string;
  /** The project root, for a root-relative `layout: /src/…`. */
  root: string;
  /** The site's `base`, the prefix of a page's `url`. */
  base: string;
  /** Astro's `trailingSlash`: `"always"` ends a page's `url` with `/`. Absent is `"ignore"`. */
  trailingSlash?: string;
  /**
   * The project is an Astro project: a page without a layout renders as Astro's does,
   * `<meta charset="utf-8">` and the content, with no document around it.
   */
  astro?: boolean;
  /** Specifier of the module exporting `markdownContent` and `markdownDocument` (the Astro shim). */
  runtime: string;
  /** Specifier of the module exporting `renderMarkdown`, with the project's plugins configured. */
  markdown: string;
}

/** The module's JavaScript. Throws, naming `label`, on invalid frontmatter or `layout:`. */
export function markdownModule(options: MarkdownModuleOptions): string {
  const { source, file, label, root, base } = options;
  const page = parseMarkdownPage(source, label);
  const layout = layoutSpecifier(markdownLayout(page.frontmatter, label), file, root);
  const url = markdownPageUrl(file, base, options.trailingSlash);
  // Astro's `Content` of a page without a layout starts with the charset, wherever it renders.
  const astroPage = options.astro === true && url !== undefined && layout === null;
  const lines = [
    `import { markdownContent as $$markdownContent, markdownDocument as $$markdownDocument } from ${literal(options.runtime)};`,
    `import { renderMarkdown as $$renderMarkdown } from ${literal(options.markdown)};`,
    ...(layout === null ? [] : [`import $$Layout from ${literal(layout)};`]),
    `const $$body = ${literal(page.body)};`,
    `export const frontmatter = ${literal(page.frontmatter)};`,
    `export const file = ${literal(file)};`,
    `export const url = ${url === undefined ? "undefined" : literal(url)};`,
    "export function rawContent() { return $$body; }",
    "let $$html;",
    "export function compiledContent() { return ($$html ??= $$renderMarkdown($$body)); }",
    // pletivo collects no headings, as for a collection entry's `render()`.
    "export function getHeadings() { return []; }",
    "const $$page = { frontmatter, file, url, rawContent, compiledContent, getHeadings };",
    `export const Content = $$markdownContent($$page, ${layout === null ? "null" : "$$Layout"}${astroPage ? ", true" : ""});`,
    // In a pletivo-native project a page without a layout keeps pletivo's minimal document.
    `export default ${layout === null && url !== undefined && !options.astro ? "$$markdownDocument($$page)" : "Content"};`,
    "",
  ];
  return lines.join("\n");
}

/**
 * A `.md` file's `layout:` exactly as written, or null without one. Throws, naming
 * `label`, on invalid frontmatter or a `layout:` that is not a string.
 */
export function markdownLayoutOf(source: string, label: string): string | null {
  return markdownLayout(parseMarkdownPage(source, label).frontmatter, label);
}

function parseMarkdownPage(source: string, label: string): { frontmatter: Record<string, unknown>; body: string } {
  try {
    return parseFrontmatter(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}: invalid frontmatter: ${message}`, { cause: error });
  }
}

function markdownLayout(frontmatter: Record<string, unknown>, label: string): string | null {
  const { layout } = frontmatter;
  if (layout === undefined || layout === null || layout === "") return null;
  if (typeof layout !== "string") {
    throw new Error(`${label}: \`layout:\` in frontmatter must be a path to the layout component, got ${JSON.stringify(layout)}`);
  }
  return layout;
}

/**
 * `layout:` as an import specifier from `file`: relative as written, root-relative
 * (`/src/layouts/…`, as Vite reads it) made relative, anything else left to the resolver.
 */
function layoutSpecifier(layout: string | null, file: string, root: string): string | null {
  if (layout === null || !layout.startsWith("/")) return layout;
  // Both sides in `root`'s form, so a project-path root (`""`) stays relative.
  const relative = path.relative(path.dirname(file), path.join(root, layout.slice(1))).split(path.sep).join("/");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

/** Astro's `url` of a Markdown file (`getFileInfo`): its route under `pages/`, or undefined for any other file. */
function markdownPageUrl(file: string, base: string, trailingSlash: string | undefined): string | undefined {
  const normalized = file.split(path.sep).join("/");
  const pages = /^(?:.*?\/)?pages\//.exec(normalized);
  if (pages === null) return undefined;
  const prefix = base.endsWith("/") ? base : `${base}/`;
  const url = (prefix + normalized.slice(pages[0].length)).replace(/(?:\/index)?\.md$/, "");
  // As in Astro, the root index's empty url stays empty.
  return trailingSlash === "always" && url !== "" && !url.endsWith("/") ? `${url}/` : url;
}

/**
 * A JS literal. `import.meta.env` in Markdown is text, so it is escaped where a host
 * would otherwise substitute it, as Astro does.
 */
function literal(value: unknown): string {
  return JSON.stringify(value).replaceAll("import.meta.env", "import\\u002Emeta.env");
}
