/** Demand-driven resolution of image URLs emitted by the render isolate. */

import type { ProjectAssetsView, ServedProjectAsset } from "./asset-port.ts";
import {
  projectAssetsView,
  type ProjectAssets,
} from "./content-files.ts";

export type ServedImage = ServedProjectAsset;

const CDN_CGI_PREFIX = "/cdn-cgi/image/";

/**
 * Resolve one image request. A legacy map is adapted without probing its values;
 * stores expose a revision-owned `ProjectAssetsView` directly.
 */
export function serveImage(
  pathname: string,
  assets: ProjectAssets | ProjectAssetsView,
): ServedImage | null | Promise<ServedImage | null> {
  return projectAssetsView(assets).resolveOutput(pathname);
}

/**
 * `/cdn-cgi/image/<options>/<source>` -> `/<source>`; anything else unchanged.
 * The view applies the same normalization before its indexed lookup.
 */
export function withoutCdnCgi(pathname: string): string {
  if (!pathname.startsWith(CDN_CGI_PREFIX)) return pathname;
  const rest = pathname.slice(CDN_CGI_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return pathname;
  return `/${rest.slice(slash + 1)}`;
}
