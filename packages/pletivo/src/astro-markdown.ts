/**
 * `.md` in an Astro project renders with `@astrojs/markdown-remark`'s defaults: `remark-smartypants`
 * after GFM, and Astro's syntax highlighter right after remark-rehype. Both load from the project's
 * own `@astrojs/markdown-remark`, as MDX's highlighter does (`mdx-syntax-highlight.ts`).
 */
import path from "path";
import { fileURLToPath } from "url";
import type { Pluggable } from "unified";
import type { MarkdownOptions } from "@pletivo/core/content/markdown";
import { astroHighlightPlugins, parseShikiConfig, parseSyntaxHighlight, resolveAstroMarkdownRemark } from "./mdx-syntax-highlight";

/** The Astro config keys this reads; `markdown` is unparsed until here. */
interface AstroMarkdownSource {
  root: URL;
  markdown?: unknown;
}

/** `options` with Astro's default plugins around the configured ones. */
export async function withAstroMarkdownDefaults(config: AstroMarkdownSource, options: MarkdownOptions): Promise<MarkdownOptions> {
  const markdown: unknown = config.markdown ?? {};
  if (typeof markdown !== "object" || markdown === null) throw new Error("astro config: markdown must be an object");
  const smartypants: unknown = Reflect.get(markdown, "smartypants") ?? true;
  if (typeof smartypants !== "boolean") throw new Error(`astro config: markdown.smartypants must be a boolean, got ${JSON.stringify(smartypants)}`);
  const projectRoot = fileURLToPath(config.root);
  const highlight = await astroHighlightPlugins({
    subject: "Markdown",
    projectRoot,
    syntaxHighlight: parseSyntaxHighlight(Reflect.get(markdown, "syntaxHighlight"), "astro config: markdown"),
    shikiConfig: parseShikiConfig(Reflect.get(markdown, "shikiConfig"), "astro config: markdown"),
  });
  return {
    ...options,
    remarkPlugins: [...(smartypants ? await loadSmartypants(projectRoot) : []), ...(options.remarkPlugins ?? [])],
    afterRemarkRehype: highlight,
  };
}

async function loadSmartypants(projectRoot: string): Promise<Pluggable[]> {
  const resolved = resolveAstroMarkdownRemark(projectRoot);
  const unavailable = (reason: string): Pluggable[] => {
    console.warn(`Markdown is rendered without smartypants: ${reason}. Set \`smartypants: false\` in \`markdown\` to silence this warning.`);
    return [];
  };
  if ("missing" in resolved) return unavailable(resolved.reason);
  let entry: string;
  try {
    entry = Bun.resolveSync("remark-smartypants", path.dirname(resolved.entry));
  } catch {
    return unavailable(`\`remark-smartypants\` cannot be resolved from ${resolved.entry}`);
  }
  const mod: unknown = await import(entry);
  const plugin = typeof mod === "object" && mod !== null ? Reflect.get(mod, "default") : undefined;
  if (typeof plugin !== "function") return unavailable(`\`remark-smartypants\` at ${entry} has no default export`);
  return [plugin];
}
