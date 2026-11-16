import path from "path";
import { markdownPageLayoutReason, parseFrontmatter } from "@pletivo/core/content/markdown";

/**
 * A `.md`/`.mdx` page's frontmatter and body, refused by its project-relative path when it
 * carries a `layout:` pletivo cannot apply yet. Page routes only: an `.mdx` imported by a
 * page, or a collection entry, keeps `layout` as plain data.
 */
export async function readMarkdownPage(
  fullPath: string,
  projectRoot: string,
): Promise<{ frontmatter: Record<string, unknown>; body: string }> {
  const page = parseFrontmatter(await Bun.file(fullPath).text());
  const unsupported = markdownPageLayoutReason(page.frontmatter);
  if (unsupported) throw new Error(`${path.relative(projectRoot, fullPath)}: ${unsupported}`);
  return page;
}

/** Refuse an `.mdx` page route's `layout:` before the page is imported; other page kinds pass. */
export async function assertPageLayoutSupported(fullPath: string, projectRoot: string): Promise<void> {
  if (fullPath.endsWith(".mdx")) await readMarkdownPage(fullPath, projectRoot);
}
