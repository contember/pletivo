/** Endpoint reading the site context, like a real catalog/sitemap route would. */
export function GET({ site }: { site?: URL }) {
  const body = JSON.stringify({ site: site?.href ?? null, items: [1, 2, 3] }, null, 2);
  return new Response(body, {
    headers: { "Content-Type": "application/json" },
  });
}
