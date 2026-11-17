import path from "path";
import { parseFrontmatter } from "@pletivo/core/content/markdown";

/**
 * Refuse an `.mdx` page route's `layout:` before the page is imported: the MDX loader does
 * not apply it, and the page would render without its layout's `<head>` and shell. Other
 * page kinds pass. Page routes only: an `.mdx` imported by a page, or a collection entry,
 * keeps `layout` as plain data.
 */
export async function assertPageLayoutSupported(fullPath: string, projectRoot: string): Promise<void> {
  if (!fullPath.endsWith(".mdx")) return;
  const file = path.relative(projectRoot, fullPath);
  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = parseFrontmatter(await Bun.file(fullPath).text()).frontmatter;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${file}: invalid frontmatter: ${message}`, { cause: error });
  }
  if (!frontmatter.layout) return;
  throw new Error(
    `${file}: \`layout:\` in frontmatter is not supported by pletivo yet; the page would render without its layout. ` +
      "Render the content from an .astro page that uses the layout, import the layout and wrap the content in it, " +
      "or remove `layout:`",
  );
}
