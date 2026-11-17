import path from "path";
import fs from "fs/promises";

/**
 * Generate sitemap.xml from the HTML pages the build wrote.
 * `pageFiles` are paths relative to `distDir`, e.g. `blog/post/index.html`.
 */
export async function generateSitemap(
  distDir: string,
  base: string,
  pageFiles: readonly string[],
  siteUrl?: string,
): Promise<void> {
  const htmlFiles = pageFiles
    .map((file) => file.split(path.sep).join("/"))
    .filter((file) => path.posix.basename(file) !== "404.html");

  const urls = htmlFiles.map((file) => {
    // Convert file path to URL
    let url = file.replace(/index\.html$/, "").replace(/\.html$/, "");
    if (!url.startsWith("/")) url = "/" + url;
    if (url !== "/" && url.endsWith("/")) url = url.slice(0, -1);

    const fullUrl = siteUrl ? siteUrl.replace(/\/$/, "") + base.replace(/\/$/, "") + url : url;
    return fullUrl;
  });

  // Sorted so the file's bytes depend on the site, not on route discovery or getStaticPaths order.
  urls.sort();

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((url) => `  <url>\n    <loc>${escapeXml(url)}</loc>\n  </url>`).join("\n")}
</urlset>
`;

  await fs.writeFile(path.join(distDir, "sitemap.xml"), xml);
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
