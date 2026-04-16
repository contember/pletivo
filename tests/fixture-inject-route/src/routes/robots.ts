/** Simulated endpoint injected by an integration */
export async function GET() {
  const body = `User-agent: *\nAllow: /\nSitemap: https://example.com/sitemap.xml`;
  return new Response(body, {
    headers: { "Content-Type": "text/plain" },
  });
}
