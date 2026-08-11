import path from "path";
import fs from "fs/promises";
import type { BunPlugin } from "bun";

/**
 * Assets referenced from CSS with `url()` — fonts, background images.
 *
 * Bun 1.3.14 inlines every `url()` target up to 131,071 B as a base64
 * `data:` URI and offers no threshold to change it, so a build that leans
 * on Bun alone ships whole webfonts inside the stylesheet with 33.5%
 * base64 overhead (and trips a `font-src 'self'` CSP, which does not
 * cover `data:`).
 *
 * The fix is to take the decision away from Bun: rewrite `url()` in the
 * CSS *before* Bun loads it, emitting anything at or above the inline
 * limit as a content-hashed file. Vite's `build.assetsInlineLimit`
 * default is 4096 B and Astro never overrides it, so that is the limit.
 *
 * The rewritten URL is a placeholder origin rather than the final `/…`
 * path: Bun tries to resolve absolute `url()` targets from disk and fails
 * the build, but leaves `http(s):` URLs alone. `stripCssAssetPlaceholders`
 * removes the origin from the built CSS, leaving the real path.
 */

const PLACEHOLDER_ORIGIN = "https://pletivo-asset-placeholder.invalid";

/** Vite's `build.assetsInlineLimit` default; Astro does not override it. */
export const DEFAULT_CSS_ASSET_INLINE_LIMIT = 4096;

export interface CssAssetOptions {
  /** Directory the extracted files are written to. */
  outDir: string;
  /** URL prefix the rewritten `url()` points at, e.g. `/assets/`. */
  publicPath: string;
  /** Assets strictly below this many bytes stay inline. */
  inlineLimit?: number;
}

interface EmittedAsset {
  /** Public URL, without the placeholder origin. */
  url: string;
  bytes: number;
}

let options: CssAssetOptions | null = null;
/** Absolute source path → emitted asset, so one font is written once. */
const emitted = new Map<string, EmittedAsset | null>();

/**
 * Enable extraction and point it at a directory. Left unconfigured (dev,
 * unit tests) the CSS is untouched and Bun keeps inlining, which is what
 * a dev server wants anyway.
 */
export function configureCssAssets(next: CssAssetOptions | null): void {
  options = next;
  emitted.clear();
}

/** Files written this build, for the build summary. */
export function emittedCssAssets(): EmittedAsset[] {
  const out: EmittedAsset[] = [];
  for (const asset of emitted.values()) {
    if (asset) out.push(asset);
  }
  return out;
}

/** Turn placeholder origins in built CSS back into real URLs. */
export function stripCssAssetPlaceholders(css: string): string {
  return css.includes(PLACEHOLDER_ORIGIN) ? css.replaceAll(PLACEHOLDER_ORIGIN, "") : css;
}

/**
 * Rewrites `url()` targets in every `.css` file Bun loads. Registered
 * *after* `cssSideEffectBunPlugin`, which short-circuits source CSS —
 * that is emitted verbatim by the main pipeline, not through Bun.
 */
export function cssAssetBunPlugin(): BunPlugin {
  return {
    name: "pletivo-css-assets",
    setup(build) {
      build.onLoad({ filter: /\.css(\?.*)?$/ }, async (args) => {
        const active = options;
        if (!active) return undefined;
        const file = args.path.split("?", 1)[0];
        let source: string;
        try {
          source = await fs.readFile(file, "utf8");
        } catch {
          return undefined;
        }
        const rewritten = await rewriteCssAssetUrls(file, source, active);
        // Handing back the untouched text would work, but letting Bun
        // read the file itself keeps the no-asset case free.
        return rewritten === source ? undefined : { contents: rewritten, loader: "css" };
      });
    },
  };
}

/** `url(x)`, `url("x")`, `url('x')`, with optional surrounding space. */
const URL_TOKEN_RE = /\burl\(\s*(["']?)([^"'()]+)\1\s*\)/g;

export async function rewriteCssAssetUrls(
  cssFile: string,
  css: string,
  active: CssAssetOptions,
): Promise<string> {
  const replacements = new Map<string, string>();
  for (const match of css.matchAll(URL_TOKEN_RE)) {
    const raw = match[2].trim();
    if (!raw || replacements.has(raw) || !isRelativeAssetRef(raw)) continue;
    const url = await emitCssAsset(cssFile, raw, active);
    if (url) replacements.set(raw, url);
  }
  if (replacements.size === 0) return css;

  return css.replace(URL_TOKEN_RE, (whole, _quote: string, target: string) => {
    const url = replacements.get(target.trim());
    return url ? `url("${PLACEHOLDER_ORIGIN}${url}")` : whole;
  });
}

function isRelativeAssetRef(ref: string): boolean {
  // `/…` is already a site-absolute URL; `#…` is an in-document fragment.
  return !/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(ref);
}

async function emitCssAsset(
  cssFile: string,
  ref: string,
  active: CssAssetOptions,
): Promise<string | null> {
  // Keep `?v=1` / `#icon` on the rewritten URL — a fragment selects a
  // sub-resource inside an SVG and the browser still needs it.
  const suffix = ref.match(/[?#].*$/)?.[0] ?? "";
  const target = suffix ? ref.slice(0, -suffix.length) : ref;
  const file = path.resolve(path.dirname(cssFile), decodeURI(target));

  const cached = emitted.get(file);
  if (cached !== undefined) return cached && cached.url + suffix;

  let bytes: Buffer;
  try {
    bytes = await fs.readFile(file);
  } catch {
    emitted.set(file, null);
    return null;
  }

  const limit = active.inlineLimit ?? DEFAULT_CSS_ASSET_INLINE_LIMIT;
  // A fragment reference cannot survive being turned into a `data:` URI,
  // so it is always a file — Vite applies the same exception.
  if (bytes.byteLength < limit && !suffix.startsWith("#")) {
    emitted.set(file, null);
    return null;
  }

  const hasher = new Bun.CryptoHasher("md5");
  hasher.update(bytes);
  const hash = hasher.digest("hex").slice(0, 8);
  const ext = path.extname(file);
  const stem = path.basename(file, ext).replace(/[^a-zA-Z0-9_-]+/g, "-") || "asset";
  const name = `${stem}.${hash}${ext}`;

  await fs.mkdir(active.outDir, { recursive: true });
  await fs.writeFile(path.join(active.outDir, name), bytes);

  const asset: EmittedAsset = {
    url: active.publicPath + name,
    bytes: bytes.byteLength,
  };
  emitted.set(file, asset);
  return asset.url + suffix;
}
