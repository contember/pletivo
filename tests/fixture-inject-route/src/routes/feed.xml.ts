/** Simulated RSS feed endpoint */
export async function GET({ site }: { site?: URL }) {
  const siteUrl = (site?.href ?? "https://example.com").replace(/\/$/, "");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test Feed</title>
    <link>${siteUrl}</link>
    <item>
      <title>First Post</title>
      <link>${siteUrl}/blog/first</link>
    </item>
  </channel>
</rss>`;
  return new Response(xml, {
    headers: { "Content-Type": "application/xml" },
  });
}
