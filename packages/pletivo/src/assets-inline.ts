import type { AstroConfig, ViteUserConfig } from "@pletivo/core/astro-host/types";
import { DEFAULT_ASSETS_INLINE_LIMIT, shouldInlineAsset, type AssetsInlineLimit } from "@pletivo/core/assets-inline";

/** Reads `vite.build.assetsInlineLimit` from the Astro config; projects without one get Vite's default. */
export function readAssetsInlineLimit(vite: ViteUserConfig | undefined): AssetsInlineLimit {
  const viteBuild = vite?.build;
  if (typeof viteBuild !== "object" || viteBuild === null || !("assetsInlineLimit" in viteBuild)) {
    return DEFAULT_ASSETS_INLINE_LIMIT;
  }
  const limit = viteBuild.assetsInlineLimit;
  if (limit === undefined) return DEFAULT_ASSETS_INLINE_LIMIT;
  if (typeof limit === "number") return limit;
  if (typeof limit === "function") {
    return (filePath, content) => {
      // Vite hands the function a Buffer.
      const verdict: unknown = limit(filePath, Buffer.from(content.buffer, content.byteOffset, content.byteLength));
      return typeof verdict === "boolean" ? verdict : undefined;
    };
  }
  throw new Error(`vite.build.assetsInlineLimit must be a number or a function, got ${typeof limit}`);
}

/** Astro's `build.inlineStylesheets`. */
export type InlineStylesheets = "always" | "auto" | "never";

/** Reads `build.inlineStylesheets`, defaulting to `"auto"` and rejecting what Astro's config schema rejects. */
export function readInlineStylesheets(build: AstroConfig["build"]): InlineStylesheets {
  const value = build.inlineStylesheets;
  if (value === undefined) return "auto";
  if (value === "always" || value === "auto" || value === "never") return value;
  throw new Error(`build.inlineStylesheets must be "always", "auto" or "never", got ${JSON.stringify(value)}`);
}

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
