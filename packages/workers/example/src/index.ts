/**
 * A preview server for a site that only exists in memory.
 *
 *   bunx wrangler dev --config packages/workers/example/wrangler.jsonc
 *
 *   GET  /            the demo project in src/site.ts
 *   POST /__render    {"files": {...}, "pathname": "/", "site": "..."} — render a
 *                     project handed in with the request, which is what a Durable
 *                     Object holding an agent's edits would do
 */

import {
  RouteNotFoundError,
  UnsupportedRouteError,
  renderPage,
  type WorkerLoaderBinding,
} from "../../src/render.ts";
import { SITE } from "./site.ts";

interface Env {
  LOADER: WorkerLoaderBinding;
}

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
    try {
      const render =
        url.pathname === "/__render"
          ? await readRenderRequest(request)
          : { files: SITE, pathname: url.pathname };

      const page = await renderPage({ ...render, loader: env.LOADER });
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
