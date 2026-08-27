/**
 * The one service a rendering page is allowed to reach here, served from memory.
 *
 * A real host's `PletivoOutbound` would forward a permitted origin to the network and
 * refuse the rest. This one answers itself, so the example and the test that drives it
 * work with no Internet at all — and so "the page fetched something" cannot quietly
 * become "the page fetched the real world".
 *
 * The token check is what makes the `astro:env` half of the test mean something: the
 * page reads `API_TOKEN` out of `astro:env/server` and sends it, and a value that never
 * arrived comes back as a 401 rather than as a page that merely looks fine.
 */

/** Must match `PLETIVO_API_BASE` in wrangler.jsonc, which is what the page fetches. */
export const API_ORIGIN = "https://api.pletivo.test";

/** Must match `PLETIVO_API_TOKEN` in wrangler.jsonc, which is what the page sends. */
export const API_TOKEN = "demo-token";

const POSTS = [
  { id: "first", title: "Rendered from a live API" },
  { id: "second", title: "…inside a Worker Loader isolate" },
];

export function apiResponse(pathname: string, authorization: string | null): Response {
  if (authorization !== `Bearer ${API_TOKEN}`) {
    return Response.json({ error: "bad token" }, { status: 401 });
  }
  if (pathname !== "/posts") {
    return Response.json({ error: `no ${pathname}` }, { status: 404 });
  }
  return Response.json(POSTS);
}
