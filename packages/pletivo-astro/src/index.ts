import tsxPages, { type TsxPagesOptions } from "@pletivo/astro-jsx-pages";
import { pletivoCompatPlugin } from "./vite-plugin";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { AstroIntegration } from "astro";

export interface PletivoAstroOptions {
  /** TSX page extensions (default: ['.tsx', '.jsx']) */
  extensions?: string[];
  /** Enable island hydration (default: true) */
  islands?: boolean;
}

/**
 * Astro integration that enables pletivo-compatible TSX pages.
 *
 * Wraps @pletivo/astro-jsx-pages and adds:
 * - Transform `client="load"` → `client:load` (pletivo syntax → Astro directives)
 * - Alias pletivo/hooks → preact/hooks
 *
 * Usage in astro.config.mjs:
 * ```js
 * import pletivo from 'pletivo-astro';
 * import preact from '@astrojs/preact';
 *
 * export default defineConfig({
 *   integrations: [preact(), pletivo()],
 * });
 * ```
 */
export default function pletivoAstro(options: PletivoAstroOptions = {}): AstroIntegration {
  const tsxPagesOptions: TsxPagesOptions = {
    extensions: options.extensions || [".tsx", ".jsx"],
    islands: options.islands ?? true,
  };

  const inner = tsxPages(tsxPagesOptions);

  return {
    name: "pletivo-astro",
    hooks: {
      "astro:config:setup": (params) => {
        // Delegate to astro-jsx-pages for TSX page support
        (inner.hooks as any)["astro:config:setup"]?.(params);

        // Add pletivo compat plugin (client="load" → client:load)
        params.updateConfig({
          vite: {
            plugins: [pletivoCompatPlugin()],
            resolve: {
              alias: {
                "pletivo/hooks": "preact/hooks",
                // Redirect `import { getCollection } from "pletivo"` to content shim
                "pletivo": path.resolve(
                  path.dirname(fileURLToPath(import.meta.url)),
                  "content-shim.ts",
                ),
              },
            },
          },
        });
      },

      "astro:config:done": (params) => {
        (inner.hooks as any)["astro:config:done"]?.(params);
      },
    },
  };
}
