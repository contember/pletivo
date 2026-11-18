import path from "path";
import fs from "fs/promises";
import type { BunPlugin } from "bun";
import { DEFAULT_ASSETS_INLINE_LIMIT, type AssetsInlineLimit } from "@pletivo/core/assets-inline";
import {
  cssAssetFileName,
  inlinesCssAsset,
  relativeCssAssetRefs,
  replaceCssAssetUrls,
  splitCssAssetRef,
} from "@pletivo/core/css-asset-urls";

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
 * limit as a content-hashed file. The limit is Vite's `build.assetsInlineLimit`,
 * 4096 B unless the Astro config sets `vite.build.assetsInlineLimit`.
 *
 * The rewritten URL is a placeholder origin rather than the final `/…`
 * path: Bun tries to resolve absolute `url()` targets from disk and fails
 * the build, but leaves `http(s):` URLs alone. `stripCssAssetPlaceholders`
 * removes the origin from the built CSS, leaving the real path.
 */

const PLACEHOLDER_ORIGIN = "https://pletivo-asset-placeholder.invalid";

export interface CssAssetOptions {
  /** Directory the extracted files are written to. */
  outDir: string;
  /** URL prefix the rewritten `url()` points at, e.g. `/assets/`. */
  publicPath: string;
  /** Vite's `build.assetsInlineLimit`: assets strictly below it stay inline. */
  inlineLimit?: AssetsInlineLimit;
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

/**
 * `rewriteCssAssetUrls` with the configured options, for CSS a plugin serves from memory
 * (this plugin reads only files on disk). Unchanged while extraction is off.
 */
export async function rewriteConfiguredCssAssetUrls(cssFile: string, css: string): Promise<string> {
  const active = options;
  return active ? await rewriteCssAssetUrls(cssFile, css, active) : css;
}

export async function rewriteCssAssetUrls(
  cssFile: string,
  css: string,
  active: CssAssetOptions,
): Promise<string> {
  const replacements = new Map<string, string>();
  for (const raw of relativeCssAssetRefs(css)) {
    const url = await emitCssAsset(cssFile, raw, active);
    if (url) replacements.set(raw, PLACEHOLDER_ORIGIN + url);
  }
  return replacements.size === 0 ? css : replaceCssAssetUrls(css, replacements);
}

async function emitCssAsset(
  cssFile: string,
  ref: string,
  active: CssAssetOptions,
): Promise<string | null> {
  const parsed = splitCssAssetRef(ref);
  const file = path.resolve(path.dirname(cssFile), parsed.file);

  const cached = emitted.get(file);
  if (cached !== undefined) return cached && cached.url + parsed.suffix;

  let bytes: Buffer;
  try {
    bytes = await fs.readFile(file);
  } catch {
    emitted.set(file, null);
    return null;
  }

  if (inlinesCssAsset(parsed, bytes, file, active.inlineLimit ?? DEFAULT_ASSETS_INLINE_LIMIT)) {
    emitted.set(file, null);
    return null;
  }

  const hasher = new Bun.CryptoHasher("md5");
  hasher.update(bytes);
  const name = cssAssetFileName(file, hasher.digest("hex").slice(0, 8));

  await fs.mkdir(active.outDir, { recursive: true });
  await fs.writeFile(path.join(active.outDir, name), bytes);

  const asset: EmittedAsset = {
    url: active.publicPath + name,
    bytes: bytes.byteLength,
  };
  emitted.set(file, asset);
  return asset.url + parsed.suffix;
}
