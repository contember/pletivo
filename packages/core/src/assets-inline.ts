/** Vite's `build.assetsInlineLimit`, which decides whether an asset ships inline or as a file on both hosts. */

/** A byte limit, or a per-file verdict where `undefined` defers to the default. */
export type AssetsInlineLimit = number | ((filePath: string, content: Uint8Array) => boolean | undefined);

/** Vite's default, which Astro does not override. */
export const DEFAULT_ASSETS_INLINE_LIMIT = 4096;

/** Astro's `shouldInlineAsset` (`core/build/plugins/util.ts`), which is Vite's rule: strictly below the limit. */
export function shouldInlineAsset(content: string | Uint8Array, filePath: string, limit: AssetsInlineLimit): boolean {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  if (typeof limit === "function") {
    return limit(filePath, bytes) ?? bytes.byteLength < DEFAULT_ASSETS_INLINE_LIMIT;
  }
  return bytes.byteLength < limit;
}
