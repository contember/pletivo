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
import {
  ContentFiles,
  type ContentBinding,
  type ContentFileRef,
  type ImageInfo,
  type ProjectAssets,
} from "../../src/content-files.ts";
import { serveImage } from "../../src/images.ts";
import type { OutboundBinding } from "../../src/outbound.ts";
import { parsePreparedSite, type PreparedSite } from "@pletivo/core/artifact";
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
  image(ref: string, path: string): ImageInfo | null {
    return CONTENT.image(ref, path);
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

/**
 * The images the last render was handed, so the browser's follow-up request for one
 * finds bytes.
 *
 * A single-site worker would hold these next to its sources; a preview server handed
 * a different project per request keeps the last one, which is exactly as much state
 * as `assets` above keeps and for the same reason.
 */
let images: ProjectAssets = new Map();

interface RenderRequest {
  files: Record<string, string>;
  /**
   * The project's binaries: base64 for the file itself, or the four fields a host
   * that keeps its files elsewhere already knows about it. Both are real shapes — a
   * site with 200 MiB of photographs cannot put them in a Worker's heap.
   */
  assets?: Record<string, string | ImageInfo>;
  pathname?: string;
  pagesDir?: string;
  site?: string;
  /** `"proxy"` puts `PletivoOutbound` in front of the isolate. Anything else: no network. */
  outbound?: string;
  /**
   * What `pletivo prepare` froze, sent with the request rather than bundled in.
   *
   * A single-site worker would import its `pletivo-artifact.ts` the way this one
   * imports `TAILWIND`; a preview server handed a different project per request has to
   * take the artifact the same way it takes the files, so that is what this does.
   */
  artifact?: unknown;
}

/** One render, as this worker performs it. */
interface ParsedRender {
  files: ReadonlyMap<string, string>;
  assets: ProjectAssets;
  pathname: string;
  pagesDir?: string;
  site?: string;
  proxyOutbound: boolean;
  artifact?: PreparedSite;
}

function isRenderRequest(value: unknown): value is RenderRequest {
  if (typeof value !== "object" || value === null) return false;
  const files: unknown = Reflect.get(value, "files");
  if (typeof files !== "object" || files === null) return false;
  if (!Object.values(files).every((source) => typeof source === "string")) return false;
  const assets: unknown = Reflect.get(value, "assets");
  if (assets === undefined) return true;
  if (typeof assets !== "object" || assets === null) return false;
  return Object.values(assets).every(isAsset);
}

function isAsset(value: unknown): value is string | ImageInfo {
  if (typeof value === "string") return true;
  if (typeof value !== "object" || value === null) return false;
  return (
    typeof Reflect.get(value, "width") === "number" &&
    typeof Reflect.get(value, "height") === "number" &&
    typeof Reflect.get(value, "format") === "string" &&
    typeof Reflect.get(value, "hash") === "string"
  );
}

/** Base64 back to bytes. `atob` is the only decoder a Worker has. */
function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export default {
  async fetch(request: Request, env: Env, ctx: RenderContext): Promise<Response> {
    const url = new URL(request.url);
    const asset = assets.get(url.pathname);
    if (asset) {
      return new Response(asset.body, { headers: { "content-type": asset.contentType } });
    }
    // `/_astro/<name>.<hash>.<ext>` and the `/cdn-cgi/image/` form a rendered page
    // links to. Content-hashed, so it can be cached forever.
    const image = serveImage(url.pathname, images);
    if (image?.bytes) {
      return new Response(image.bytes, {
        headers: { "content-type": image.contentType, "cache-control": "public, max-age=31536000, immutable" },
      });
    }

    // Made per request, but it is only *used* the first time an isolate is created —
    // `env.LOADER.get` runs its code factory on a cache miss and never again. That is
    // why the stub is stateless and every call carries a ref instead.
    const content = { binding: ctx.exports.PletivoContent({}), store: CONTENT };

    try {
      if (url.pathname === "/__paths") {
        const { files, assets, pagesDir, artifact } = await readRenderRequest(request);
        return Response.json(
          await projectPaths({ files, assets, pagesDir, artifact, loader: env.LOADER, content }),
        );
      }

      const parsed: ParsedRender =
        url.pathname === "/__render"
          ? await readRenderRequest(request)
          : { files: SITE, assets: images, pathname: url.pathname, proxyOutbound: false };
      const { proxyOutbound, ...render } = parsed;
      // What the *next* GET for an image URL will be answered from. A real host holds
      // its own files; this one is handed them with the render that named them.
      images = render.assets;

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
  // A malformed artifact is dropped rather than half-read: `parsePreparedSite`
  // returns null, the render proceeds without it, and the bare specifier it would
  // have answered fails by name at the Loader.
  const artifact = body.artifact === undefined ? undefined : parsePreparedSite(body.artifact);
  if (body.artifact !== undefined && artifact === null) {
    throw new Error("POST /__render was given an artifact this host cannot read");
  }
  return {
    files: new Map(Object.entries(body.files)),
    assets: new Map(
      Object.entries(body.assets ?? {}).map(([path, asset]) => [
        path,
        typeof asset === "string" ? decodeBase64(asset) : asset,
      ]),
    ),
    pathname: body.pathname ?? "/",
    pagesDir: body.pagesDir,
    site: body.site,
    // An exact match, so a typo asks for nothing rather than for the network.
    proxyOutbound: body.outbound === "proxy",
    ...(artifact ? { artifact } : {}),
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
