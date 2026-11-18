/**
 * Relative `url()` targets in CSS, as `pletivo build` emits them: a content-hashed file,
 * or, below the inline limit, left for the bundler to inline as a `data:` URI. Shared so
 * the Workers host names the same file the Bun host writes. Reading the bytes and hashing
 * them stay with each host.
 */

import { shouldInlineAsset, type AssetsInlineLimit } from "./assets-inline";

/** `url(x)`, `url("x")`, `url('x')`, with optional surrounding space. */
const URL_TOKEN_RE = /\burl\(\s*(["']?)([^"'()]+)\1\s*\)/g;

/** The distinct relative `url()` targets in `css`, as written and trimmed, in source order. */
export function relativeCssAssetRefs(css: string): string[] {
  const refs = new Set<string>();
  for (const match of css.matchAll(URL_TOKEN_RE)) {
    const raw = match[2].trim();
    if (raw && isRelativeAssetRef(raw)) refs.add(raw);
  }
  return [...refs];
}

/** `css` with every `url()` whose trimmed target is a key of `urls` pointing at its value instead. */
export function replaceCssAssetUrls(css: string, urls: ReadonlyMap<string, string>): string {
  return css.replace(URL_TOKEN_RE, (whole, _quote: string, target: string) => {
    const url = urls.get(target.trim());
    return url === undefined ? whole : `url("${url}")`;
  });
}

function isRelativeAssetRef(ref: string): boolean {
  // `/…` is already a site-absolute URL; `#…` is an in-document fragment.
  return !/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(ref);
}

export interface CssAssetRef {
  /** The URI-decoded path, relative to the stylesheet. */
  file: string;
  /** `?query` and `#fragment` as written, kept on the rewritten URL. */
  suffix: string;
}

/** Splits a relative target. A fragment selects a sub-resource inside an SVG and the browser still needs it. */
export function splitCssAssetRef(ref: string): CssAssetRef {
  const suffix = ref.match(/[?#].*$/)?.[0] ?? "";
  const target = suffix ? ref.slice(0, -suffix.length) : ref;
  return { file: decodeURI(target), suffix };
}

/**
 * Whether a target is left for the bundler to inline. A fragment reference cannot survive
 * being turned into a `data:` URI, so it is always a file — Vite applies the same exception,
 * before the limit.
 */
export function inlinesCssAsset(
  ref: CssAssetRef,
  bytes: Uint8Array,
  filePath: string,
  limit: AssetsInlineLimit,
): boolean {
  return !ref.suffix.startsWith("#") && shouldInlineAsset(bytes, filePath, limit);
}

/** The emitted file name: `<stem>.<hash><ext>`, the stem reduced to URL-safe characters. */
export function cssAssetFileName(filePath: string, hash: string): string {
  const name = filePath.slice(Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\")) + 1);
  const dot = name.lastIndexOf(".");
  const ext = dot <= 0 ? "" : name.slice(dot);
  const stem = (ext ? name.slice(0, -ext.length) : name).replace(/[^a-zA-Z0-9_-]+/g, "-") || "asset";
  return `${stem}.${hash}${ext}`;
}
