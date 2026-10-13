/** A `.md` page as `build.ts` renders one: the body in a minimal document. */
export function markdownPageHtml(html: string, frontmatter: Record<string, unknown>): string {
  const title = typeof frontmatter.title === "string" ? frontmatter.title : "";
  return (
    `<!DOCTYPE html><html><head><meta charset="utf-8">` +
    `${title ? `<title>${title}</title>` : ""}</head><body>${html}</body></html>`
  );
}
