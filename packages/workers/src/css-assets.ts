/**
 * Relative `url()` targets in a stylesheet this host inlines, rewritten to what
 * `pletivo build` writes (`packages/pletivo/src/css-assets.ts`): a file under `/assets/`
 * named by the md5 of its bytes, or below the inline limit the `data:` URI Bun inlines it
 * as. Read on every render, so an edited target gets a new URL.
 *
 * The limit is Vite's default. A project's `vite.build.assetsInlineLimit` does not reach
 * this host: the artifact does not carry it.
 */

import {
  cssAssetFileName,
  inlinesCssAsset,
  relativeCssAssetRefs,
  replaceCssAssetUrls,
  splitCssAssetRef,
  type CssAssetRef,
} from "@pletivo/core/css-asset-urls";
import { md5Hex } from "@pletivo/core/md5";
import { normalizeProjectPath } from "./project-path.ts";
import type { ProjectFiles } from "./project-store.ts";

/** Where `pletivo build` writes a `url()` target, under base path `/`. */
export const CSS_ASSET_PREFIX = "/assets/";

/** A project file's raw bytes, or `undefined` when the project has none at that path. */
export type ReadProjectBytes = (path: string) => Uint8Array<ArrayBuffer> | undefined;

/** The store's bytes, or for a store that holds only text, a file's text encoded. */
export function projectBytes(files: ProjectFiles, readBytes: ReadProjectBytes | undefined): ReadProjectBytes {
  if (readBytes !== undefined) return readBytes;
  const encoder = new TextEncoder();
  return (path) => {
    const text = files.get(path);
    return text === undefined ? undefined : new Uint8Array(encoder.encode(text));
  };
}

/**
 * A project file a CSS asset URL names, and the md5 of the bytes it was named after. The
 * host serves the file from the project as it is then, never a copy.
 */
export interface CssAssetTarget {
  path: string;
  md5: string;
}

/** A URL a page's CSS links to, and the file it names. */
export interface CssAssetLink extends CssAssetTarget {
  url: string;
}

/**
 * How many targets one URL keeps. Files with the same name and bytes at different paths
 * share a URL; past this many, the oldest recorded is dropped.
 */
export const MAX_CSS_ASSET_TARGETS = 8;

/** `targets` with `target` added as the newest, replacing an entry for its path, capped. */
export function withCssAssetTarget(targets: readonly CssAssetTarget[], target: CssAssetTarget): CssAssetTarget[] {
  const next = targets.filter((known) => known.path !== target.path);
  next.push({ path: target.path, md5: target.md5 });
  return next.slice(-MAX_CSS_ASSET_TARGETS);
}

function cssAssetUrl(path: string, md5: string): string {
  return CSS_ASSET_PREFIX + cssAssetFileName(path, md5.slice(0, 8));
}

/**
 * Targets read back from a `GeneratedAssetStore`, or none when the value is not what this
 * host writes for `url`: at most `MAX_CSS_ASSET_TARGETS` entries, each a normalized
 * project path whose name and md5 spell exactly that URL.
 */
export function parseCssAssetTargets(url: string, value: unknown): CssAssetTarget[] {
  if (!Array.isArray(value) || value.length > MAX_CSS_ASSET_TARGETS) return [];
  const targets: CssAssetTarget[] = [];
  for (const entry of value) {
    const target = parseCssAssetTarget(url, entry);
    if (target === null) return [];
    targets.push(target);
  }
  return targets;
}

function parseCssAssetTarget(url: string, value: unknown): CssAssetTarget | null {
  if (typeof value !== "object" || value === null) return null;
  const path: unknown = Reflect.get(value, "path");
  const md5: unknown = Reflect.get(value, "md5");
  if (typeof path !== "string" || typeof md5 !== "string" || !/^[0-9a-f]{32}$/.test(md5)) return null;
  if (path === "" || normalizeProjectPath(path) !== path || cssAssetUrl(path, md5) !== url) return null;
  return { path, md5 };
}

/** The file `target` names, while its bytes still have the recorded md5; else `null`. */
export function recordedCssAsset(target: CssAssetTarget, read: ReadProjectBytes): Uint8Array<ArrayBuffer> | null {
  const bytes = read(target.path);
  return bytes !== undefined && md5Hex(bytes) === target.md5 ? bytes : null;
}

/** The name a `url()` target is written under: `/assets/<stem>.<8 hex><ext>`. */
const CSS_ASSET_PATH = /^\/assets\/[A-Za-z0-9_-]+\.[0-9a-f]{8}(?:\.[^/.]*)?$/;

/** Whether a URL path has the shape of a `url()` target this host writes. */
export function isCssAssetPath(pathname: string): boolean {
  return CSS_ASSET_PATH.test(pathname);
}

/** A target's `%` escapes do not decode. The Bun host fails the build on it with a bare `URIError`. */
export class CssAssetUrlError extends Error {
  constructor(
    readonly stylesheet: string,
    readonly specifier: string,
    cause: unknown,
  ) {
    super(`[pletivo-workers] malformed URL ${JSON.stringify(specifier)} in ${stylesheet}`, { cause });
    this.name = "CssAssetUrlError";
  }
}

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
 * it now links to is added to `emitted`, keyed by its URL and path: two paths can share a URL.
 */
export function rewriteCssAssets(
  stylesheet: string,
  css: string,
  read: ReadProjectBytes,
  emitted: Map<string, CssAssetLink>,
  inlineLimit: number,
): string {
  const urls = new Map<string, string>();
  for (const specifier of relativeCssAssetRefs(css)) {
    const ref = splitRef(stylesheet, specifier);
    const path = resolveFrom(stylesheet, ref.file);
    const bytes = path === null ? undefined : read(path);
    if (path === null || bytes === undefined) throw new CssAssetNotFoundError(stylesheet, specifier);
    if (inlinesCssAsset(ref, bytes, path, inlineLimit)) {
      urls.set(specifier, `data:${dataUriType(path)};base64,${base64(bytes)}`);
      continue;
    }
    const md5 = md5Hex(bytes);
    const url = cssAssetUrl(path, md5);
    emitted.set(`${url}\n${path}`, { url, path, md5 });
    urls.set(specifier, url + ref.suffix);
  }
  return urls.size === 0 ? css : replaceCssAssetUrls(css, urls);
}

function splitRef(stylesheet: string, specifier: string): CssAssetRef {
  try {
    return splitCssAssetRef(specifier);
  } catch (error) {
    if (error instanceof URIError) throw new CssAssetUrlError(stylesheet, specifier, error);
    throw error;
  }
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
 * The media type Bun 1.4 writes into a `data:` URI it inlines for the listed extensions,
 * matched case-insensitively; others get application/octet-stream.
 * `test/css-data-uri-types.test.ts` checks every entry against `Bun.build`.
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
  ".wasm": "application/wasm",
  ".zip": "application/zip",
};

function dataUriType(path: string): string {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  const extension = dot > slash ? path.slice(dot).toLowerCase() : "";
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
