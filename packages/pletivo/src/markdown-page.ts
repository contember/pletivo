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
  const file = path.relative(projectRoot, fullPath);
  let page: { frontmatter: Record<string, unknown>; body: string };
  try {
    page = parseFrontmatter(await Bun.file(fullPath).text());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${file}: invalid frontmatter: ${message}`, { cause: error });
  }
  const unsupported = markdownPageLayoutReason(file, page.frontmatter);
  if (unsupported) throw new Error(`${file}: ${unsupported}`);
  return page;
}

/** Refuse an `.mdx` page route's `layout:` before the page is imported; other page kinds pass. */
export async function assertPageLayoutSupported(fullPath: string, projectRoot: string): Promise<void> {
  if (fullPath.endsWith(".mdx")) await readMarkdownPage(fullPath, projectRoot);
}
