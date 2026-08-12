/**
 * Serving the images a rendered page links to.
 *
 * A render emits two kinds of image URL and the host has to answer both, or the page
 * is worse than one with no images at all:
 *
 *  - `/_astro/<name>.<hash>.<ext>` — the file itself, named by the hash of its bytes.
 *    `import hero from "./hero.png"` and an `image()` schema both produce it.
 *  - `/cdn-cgi/image/<options>/_astro/<name>.<hash>.<ext>` — what `<Image>` emits,
 *    because the isolate chose the Cloudflare image service (`astro-assets.ts`).
 *
 * The second is deliberately *not* parsed for its options here. On Cloudflare the
 * origin performs the transform and this path is never reached; anywhere else — a
 * `wrangler dev`, a preview server, a Worker without image resizing enabled — the
 * honest answer is the original file, which is what `onerror=redirect` asks for
 * anyway. What this host will not do is invent a resized image or serve a `.webp`
 * name over PNG bytes.
 *
 * Names are content hashes, so an answer is never stale and may be cached forever.
 */

import { imageContentType, imageOutputPath } from "@pletivo/core/image";
import { assetInfo, type ImageInfo, type ProjectAssets } from "./content-files.ts";

export interface ServedImage {
  /** Root-absolute URL path, exactly as a rendered page spells it. */
  path: string;
  contentType: string;
  /**
   * `null` when the host holds a manifest rather than the file — the URL is still
   * this one, and serving it is that host's own business (R2, a DO's storage).
   */
  bytes: Uint8Array | null;
  /** The file-map key it came from, which is what a host looks its own copy up by. */
  source: string;
}

const CDN_CGI_PREFIX = "/cdn-cgi/image/";

/**
 * Every image URL the project can produce, whether or not a page linked to it.
 *
 * Derived from the bytes alone: the naming is `@pletivo/core/image`'s, so this agrees
 * with what an isolate emitted without having to be told what it emitted.
 *
 * Memoized against the asset map, for the same reason and in the same way the probe
 * is — a host that keeps its assets builds this once.
 */
export function imageAssets(assets: ProjectAssets): ReadonlyMap<string, ServedImage> {
  const cached = routeCache.get(assets);
  if (cached) return cached;
  const routes = new Map<string, ServedImage>();
  for (const [source, asset] of assets) {
    let info: ImageInfo;
    try {
      info = assetInfo(asset, source);
    } catch {
      // Not an image this host can read a header out of, so nothing ever linked to it
      // under a hashed name. Left out rather than served under a guessed one.
      continue;
    }
    const path = `/${imageOutputPath(source, info.hash)}`;
    routes.set(path, {
      path,
      contentType: imageContentType(info.format),
      bytes: asset instanceof Uint8Array ? asset : null,
      source,
    });
  }
  routeCache.set(assets, routes);
  return routes;
}

const routeCache = new WeakMap<ProjectAssets, Map<string, ServedImage>>();

/**
 * The image behind one request, or `null` when this host has never heard of it.
 *
 * `null` is a real answer, not a failure: a page may reference `public/` files this
 * map knows nothing about, and those are the host's own to serve.
 */
export function serveImage(pathname: string, assets: ProjectAssets): ServedImage | null {
  return imageAssets(assets).get(withoutCdnCgi(pathname)) ?? null;
}

/**
 * `/cdn-cgi/image/<options>/<source>` -> `/<source>`; anything else unchanged.
 *
 * The options are dropped, which is the whole statement this host makes about them:
 * it cannot resize, so it serves what was asked to be resized.
 */
export function withoutCdnCgi(pathname: string): string {
  if (!pathname.startsWith(CDN_CGI_PREFIX)) return pathname;
  const rest = pathname.slice(CDN_CGI_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return pathname;
  return `/${rest.slice(slash + 1)}`;
}
