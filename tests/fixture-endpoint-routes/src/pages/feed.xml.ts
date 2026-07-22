export function GET() {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>Feed</title></channel></rss>`;
  return new Response(xml, { headers: { "Content-Type": "application/xml" } });
}
