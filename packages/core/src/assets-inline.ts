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

/** Astro's `build.inlineStylesheets`. */
export type InlineStylesheets = "always" | "auto" | "never";

/**
 * Whether a built stylesheet is inlined as `<style>` instead of linked, given its
 * final text and its dist-relative file name (`plugin-css.ts`'s inline-stylesheets
 * plugin). `null` links every sheet.
 */
export type StylesheetInliner = (css: string, fileName: string) => boolean;

export function stylesheetInliner(mode: InlineStylesheets, limit: AssetsInlineLimit): StylesheetInliner | null {
  if (mode === "never") return null;
  if (mode === "always") return () => true;
  return (css, fileName) => shouldInlineAsset(css, fileName, limit);
}
