import tsxPages, { type TsxPagesOptions } from "@pavouk/astro-jsx-pages";
import { pavoukCompatPlugin } from "./vite-plugin";
import type { AstroIntegration } from "astro";

export interface PavoukAstroOptions {
  /** TSX page extensions (default: ['.tsx', '.jsx']) */
  extensions?: string[];
  /** Enable island hydration (default: true) */
  islands?: boolean;
}

/**
 * Astro integration that enables pavouk-compatible TSX pages.
 *
 * Wraps @pavouk/astro-jsx-pages and adds:
 * - Transform `client="load"` → `client:load` (pavouk syntax → Astro directives)
 * - Alias pavouk/hooks → preact/hooks
 *
 * Usage in astro.config.mjs:
 * ```js
 * import pavouk from 'pavouk-astro';
 * import preact from '@astrojs/preact';
 *
 * export default defineConfig({
 *   integrations: [preact(), pavouk()],
 * });
 * ```
 */
export default function pavoukAstro(options: PavoukAstroOptions = {}): AstroIntegration {
  const tsxPagesOptions: TsxPagesOptions = {
    extensions: options.extensions || [".tsx", ".jsx"],
    islands: options.islands ?? true,
  };

  const inner = tsxPages(tsxPagesOptions);

  return {
    name: "pavouk-astro",
    hooks: {
      "astro:config:setup": (params) => {
        // Delegate to astro-jsx-pages for TSX page support
        (inner.hooks as any)["astro:config:setup"]?.(params);

        // Add pavouk compat plugin (client="load" → client:load)
        params.updateConfig({
          vite: {
            plugins: [pavoukCompatPlugin()],
            resolve: {
              alias: {
                "pavouk/hooks": "preact/hooks",
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
