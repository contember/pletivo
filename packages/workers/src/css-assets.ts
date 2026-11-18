/**
 * Relative `url()` targets in a stylesheet this host inlines, rewritten to what
 * `pletivo build` writes (`packages/pletivo/src/css-assets.ts`): a file under `/assets/`
 * named by the md5 of its bytes, or below the inline limit the `data:` URI Bun inlines it
 * as. Read on every render, so an edited target gets a new URL.
 *
 * The limit is Vite's default. A project's `vite.build.assetsInlineLimit` does not reach
 * this host: the artifact does not carry it.
 */

import { DEFAULT_ASSETS_INLINE_LIMIT } from "@pletivo/core/assets-inline";
import {
  cssAssetFileName,
  inlinesCssAsset,
  relativeCssAssetRefs,
  replaceCssAssetUrls,
  splitCssAssetRef,
} from "@pletivo/core/css-asset-urls";
import { md5Hex } from "@pletivo/core/md5";
import { publicContentType } from "./public-files.ts";
import type { RenderedAsset } from "./render.ts";

/** Where `pletivo build` writes a `url()` target, under base path `/`. */
export const CSS_ASSET_PREFIX = "/assets/";

/** A project file's raw bytes, or `undefined` when the project has none at that path. */
export type ReadProjectBytes = (path: string) => Uint8Array<ArrayBuffer> | undefined;

/** A relative `url()` names no file in the project. The Bun host fails the build on it. */
export class CssAssetNotFoundError extends Error {
  constructor(
    readonly stylesheet: string,
    readonly specifier: string,
  ) {
    super(`[pletivo-workers] Could not resolve: ${JSON.stringify(specifier)} in ${stylesheet}`);
    this.name = "CssAssetNotFoundError";
  }
}

/**
 * `css` of the project file `stylesheet` with each relative `url()` rewritten. Every file
 * it now links to is added to `emitted`, keyed by its URL path.
 */
export function rewriteCssAssets(
  stylesheet: string,
  css: string,
  read: ReadProjectBytes,
  emitted: Map<string, RenderedAsset>,
): string {
  const urls = new Map<string, string>();
  for (const specifier of relativeCssAssetRefs(css)) {
    const ref = splitCssAssetRef(specifier);
    const path = resolveFrom(stylesheet, ref.file);
    const bytes = path === null ? undefined : read(path);
    if (path === null || bytes === undefined) throw new CssAssetNotFoundError(stylesheet, specifier);
    if (inlinesCssAsset(ref, bytes, path, DEFAULT_ASSETS_INLINE_LIMIT)) {
      urls.set(specifier, `data:${dataUriType(path)};base64,${base64(bytes)}`);
      continue;
    }
    const url = CSS_ASSET_PREFIX + cssAssetFileName(path, md5Hex(bytes).slice(0, 8));
    emitted.set(url, { path: url, contentType: publicContentType(path), body: bytes });
    urls.set(specifier, url + ref.suffix);
  }
  return urls.size === 0 ? css : replaceCssAssetUrls(css, urls);
}

/** `file` against the stylesheet's directory, or `null` when it climbs out of the project. */
function resolveFrom(stylesheet: string, file: string): string | null {
  const segments = stylesheet.split("/").slice(0, -1);
  for (const segment of file.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment !== "..") segments.push(segment);
    else if (segments.pop() === undefined) return null;
  }
  return segments.join("/");
}

/**
 * The media type Bun 1.3.14 writes into a `data:` URI it inlines, by extension. Bun
 * matches case-sensitively: `.PNG` is an octet stream. `test/css-data-uri-types.test.ts`
 * checks every entry against `Bun.build`.
 */
export const DATA_URI_TYPES: Readonly<Record<string, string>> = {
  ".svg": "image/svg+xml",
  ".svgz": "image/svg+xml",
  ".png": "image/png",
  ".apng": "image/apng",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".jpe": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".bmp": "image/x-ms-bmp",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".jp2": "image/jp2",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".ttc": "font/collection",
  ".eot": "application/vnd.ms-fontobject",
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".ogv": "video/ogg",
  ".mp3": "audio/mpeg",
  ".wav": "audio/x-wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".m4a": "audio/x-m4a",
  ".aac": "audio/x-aac",
  ".flac": "audio/x-flac",
  ".weba": "audio/webm",
  ".mid": "audio/midi",
  ".midi": "audio/midi",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".xml": "application/xml",
  ".wasm": "application/wasm",
  ".zip": "application/zip",
};

function dataUriType(path: string): string {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  const extension = dot > slash ? path.slice(dot) : "";
  return DATA_URI_TYPES[extension] ?? "application/octet-stream";
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  // Chunked: spreading a whole file into one call overflows the argument limit.
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary);
}
