import path from "path";
import fs from "fs/promises";

/**
 * Generate sitemap.xml from a list of built page paths
 */
export async function generateSitemap(
  distDir: string,
  base: string,
  siteUrl?: string,
): Promise<void> {
  // Scan dist/ for all HTML files
  const htmlFiles = await scanHtmlFiles(distDir, "");

  const urls = htmlFiles.map((file) => {
    // Convert file path to URL
    let url = file.replace(/index\.html$/, "").replace(/\.html$/, "");
    if (!url.startsWith("/")) url = "/" + url;
    if (url !== "/" && url.endsWith("/")) url = url.slice(0, -1);

    const fullUrl = siteUrl ? siteUrl.replace(/\/$/, "") + base.replace(/\/$/, "") + url : url;
    return fullUrl;
  });

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((url) => `  <url>\n    <loc>${escapeXml(url)}</loc>\n  </url>`).join("\n")}
</urlset>
`;

  await fs.writeFile(path.join(distDir, "sitemap.xml"), xml);
}

async function scanHtmlFiles(dir: string, prefix: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      // Skip _islands and assets directories
      if (entry.name.startsWith("_") || entry.name === "assets") continue;
      files.push(...await scanHtmlFiles(path.join(dir, entry.name), rel));
    } else if (entry.name.endsWith(".html") && entry.name !== "404.html") {
      files.push(rel);
    }
  }

  return files;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
