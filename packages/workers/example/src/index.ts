/**
 * A preview server for a site that only exists in memory.
 *
 *   bunx wrangler dev --config packages/workers/example/wrangler.jsonc
 *
 *   GET  /            the demo project in src/site.ts
 *   GET  /assets/…    a file a rendered page linked to
 *   POST /__render    {"files": {...}, "pathname": "/", "site": "..."} — render a
 *                     project handed in with the request, which is what a Durable
 *                     Object holding an agent's edits would do
 */

import {
  RouteNotFoundError,
  UnsupportedRouteError,
  renderPage,
  type RenderedAsset,
  type WorkerLoaderBinding,
} from "../../src/render.ts";
import { SITE } from "./site.ts";
import { TAILWIND } from "./tailwind.ts";

interface Env {
  LOADER: WorkerLoaderBinding;
}

/**
 * What the last renders linked to, so the browser's follow-up request for
 * `/assets/styles.<hash>.css` finds bytes.
 *
 * A real host would put these behind its own cache — the names are content hashes, so
 * an entry is never stale. Here the map is bounded by the crudest means available,
 * because a preview server should not grow without limit.
 */
const assets = new Map<string, RenderedAsset>();
const ASSET_LIMIT = 32;

interface RenderRequest {
  files: Record<string, string>;
  pathname?: string;
  pagesDir?: string;
  site?: string;
}

function isRenderRequest(value: unknown): value is RenderRequest {
  if (typeof value !== "object" || value === null) return false;
  const files: unknown = Reflect.get(value, "files");
  if (typeof files !== "object" || files === null) return false;
  return Object.values(files).every((source) => typeof source === "string");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const asset = assets.get(url.pathname);
    if (asset) {
      return new Response(asset.body, { headers: { "content-type": asset.contentType } });
    }

    try {
      const render =
        url.pathname === "/__render"
          ? await readRenderRequest(request)
          : { files: SITE, pathname: url.pathname };

      const page = await renderPage({ ...render, loader: env.LOADER, tailwind: TAILWIND });
      if (assets.size >= ASSET_LIMIT) assets.clear();
      for (const generated of page.assets) assets.set(generated.path, generated);

      return new Response(page.html, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "x-pletivo-page": page.file,
          "x-pletivo-bundle": page.bundleId,
        },
      });
    } catch (error) {
      const status = error instanceof RouteNotFoundError ? 404 : 500;
      const detail =
        error instanceof RouteNotFoundError || error instanceof UnsupportedRouteError
          ? error.message
          : error instanceof Error
            ? (error.stack ?? error.message)
            : String(error);
      return new Response(detail, {
        status,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
  },
};

async function readRenderRequest(request: Request): Promise<{
  files: Map<string, string>;
  pathname: string;
  pagesDir: string | undefined;
  site: string | undefined;
}> {
  const body: unknown = await request.json();
  if (!isRenderRequest(body)) {
    throw new Error('POST /__render wants {"files": {path: source}, "pathname": "/"}');
  }
  return {
    files: new Map(Object.entries(body.files)),
    pathname: body.pathname ?? "/",
    pagesDir: body.pagesDir,
    site: body.site,
  };
}
