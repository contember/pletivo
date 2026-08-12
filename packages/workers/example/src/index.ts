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
 *   POST /__paths     the same body, minus the pathname — every page the project can
 *                     enumerate, which is what a preview index would list
 *
 * `/__render` also takes `"outbound": "proxy"`, which is the only way to get a page's
 * `fetch()` out of the isolate here. Without it the isolate reaches nothing, which is
 * what every other route gets; `test/outbound.ts` drives both sides of that.
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import {
  RouteNotFoundError,
  UnsupportedRouteError,
  projectPaths,
  renderPage,
  type RenderedAsset,
  type WorkerLoaderBinding,
} from "../../src/render.ts";
import { ContentFiles, type ContentBinding, type ContentFileRef } from "../../src/content-files.ts";
import type { OutboundAccess, OutboundBinding } from "../../src/outbound.ts";
import type { ProjectEnv } from "../../src/env.ts";
import { SITE } from "./site.ts";
import { TAILWIND } from "./tailwind.ts";
import { API_ORIGIN, apiResponse } from "./api.ts";

interface Env {
  LOADER: WorkerLoaderBinding;
  /**
   * What a rendered page reads through `astro:env/server`. Plain `vars` here because
   * the example has nothing worth hiding; on a real host the token would be a secret,
   * and it would reach the isolate by exactly this path either way.
   */
  PLETIVO_API_BASE?: string;
  PLETIVO_API_TOKEN?: string;
}

/**
 * `ctx.exports` — the self-referential bindings a Worker can hand to something else.
 * Declared structurally, like `WorkerLoaderBinding`, so the package does not depend
 * on which `@cloudflare/workers-types` the app installed.
 *
 * The entrypoint has to be *called* with an options object: `ctx.exports.X()` throws,
 * and `ctx.exports.X` uncalled is not serializable into a dynamic Worker's `env`.
 */
interface RenderContext {
  exports: {
    PletivoContent: (options: { props?: unknown }) => ContentBinding;
    PletivoOutbound: (options: { props?: unknown }) => OutboundBinding;
  };
}

/** Content files the renders in flight are reading. */
const CONTENT = new ContentFiles();

/**
 * The loopback the render isolate calls to read content, and the reason content never
 * has to enter the module map. `globalOutbound: null` still holds inside that isolate
 * — this is a capability, not the network.
 */
export class PletivoContent extends WorkerEntrypoint {
  scan(ref: string, dir: string, pattern: string): ContentFileRef[] {
    return CONTENT.scan(ref, dir, pattern);
  }
  read(ref: string, path: string): string | null {
    return CONTENT.read(ref, path);
  }
}

/**
 * Everything a rendering page's `fetch()` is allowed to reach, when a render asks for
 * one at all.
 *
 * This is what `globalOutbound` takes instead of `null`: the isolate's whole network
 * comes through here, so an origin this method does not name does not exist as far as
 * a page is concerned. A real host would `return fetch(request)` for the origins it
 * permits; this one answers out of `api.ts`, so the example — and the test that drives
 * it — needs no Internet at all.
 */
export class PletivoOutbound extends WorkerEntrypoint {
  fetch(request: Request): Response {
    const url = new URL(request.url);
    if (url.origin !== API_ORIGIN) {
      return new Response(`[example] the render isolate may not reach ${url.origin}`, {
        status: 403,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return apiResponse(url.pathname, request.headers.get("authorization"));
  }
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
  /** `"proxy"` puts `PletivoOutbound` in front of the isolate. Anything else: no network. */
  outbound?: string;
}

/** One render, as this worker performs it. */
interface ParsedRender {
  files: ReadonlyMap<string, string>;
  pathname: string;
  pagesDir?: string;
  site?: string;
  proxyOutbound: boolean;
}

function isRenderRequest(value: unknown): value is RenderRequest {
  if (typeof value !== "object" || value === null) return false;
  const files: unknown = Reflect.get(value, "files");
  if (typeof files !== "object" || files === null) return false;
  return Object.values(files).every((source) => typeof source === "string");
}

export default {
  async fetch(request: Request, env: Env, ctx: RenderContext): Promise<Response> {
    const url = new URL(request.url);
    const asset = assets.get(url.pathname);
    if (asset) {
      return new Response(asset.body, { headers: { "content-type": asset.contentType } });
    }

    // Made per request, but it is only *used* the first time an isolate is created —
    // `env.LOADER.get` runs its code factory on a cache miss and never again. That is
    // why the stub is stateless and every call carries a ref instead.
    const content = { binding: ctx.exports.PletivoContent({}), store: CONTENT };

    try {
      if (url.pathname === "/__paths") {
        const { files, pagesDir } = await readRenderRequest(request);
        return Response.json(
          await projectPaths({ files, pagesDir, loader: env.LOADER, content }),
        );
      }

      const parsed: ParsedRender =
        url.pathname === "/__render"
          ? await readRenderRequest(request)
          : { files: SITE, pathname: url.pathname, proxyOutbound: false };
      const { proxyOutbound, ...render } = parsed;

      const page = await renderPage({
        ...render,
        loader: env.LOADER,
        content,
        tailwind: TAILWIND,
        env: siteEnv(env),
        // Cut off unless this render asked for the proxy. Saying it as a ternary
        // rather than leaving the option out on one branch is the point of the
        // option's shape: there is no path here that reaches the open Internet.
        outbound: proxyOutbound
          ? { kind: "proxy", binding: ctx.exports.PletivoOutbound({}) }
          : { kind: "blocked" },
      });
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

async function readRenderRequest(request: Request): Promise<ParsedRender> {
  const body: unknown = await request.json();
  if (!isRenderRequest(body)) {
    throw new Error('POST /__render wants {"files": {path: source}, "pathname": "/"}');
  }
  return {
    files: new Map(Object.entries(body.files)),
    pathname: body.pathname ?? "/",
    pagesDir: body.pagesDir,
    site: body.site,
    // An exact match, so a typo asks for nothing rather than for the network.
    proxyOutbound: body.outbound === "proxy",
  };
}

/**
 * What a rendered page reads through `astro:env/server`.
 *
 * The worker's own configuration, not the project's: nothing here evaluates
 * `astro.config.*`, so the schema this host answers to is whatever it puts in this
 * object. Unset vars are left out rather than sent as empty strings, so a page sees
 * `undefined` — what the Bun host gives for an unset `process.env` entry.
 */
function siteEnv(env: Env): ProjectEnv {
  const server: Record<string, string> = {};
  if (env.PLETIVO_API_BASE) server.API_BASE = env.PLETIVO_API_BASE;
  if (env.PLETIVO_API_TOKEN) server.API_TOKEN = env.PLETIVO_API_TOKEN;
  return { server };
}
