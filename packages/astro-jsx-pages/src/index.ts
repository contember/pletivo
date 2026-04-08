import type { AstroIntegration, AstroRenderer, HookParameters } from 'astro';
import { vitePluginTsxIslandsPre, vitePluginTsxIslandsPost } from './vite-plugin-tsx-islands.js';
import { ASTRO_JSX_RENDERER } from './constants.js';

/**
 * Extended hook parameters that include internal Astro APIs.
 *
 * WARNING: `addPageExtension` is not a public API and may change in future Astro versions.
 * This integration relies on it to register TSX/JSX files as page sources.
 * If this API changes, the integration will need to be updated accordingly.
 *
 * @see https://github.com/withastro/astro - Check Astro's internal implementation for changes
 */
type SetupHookParams = HookParameters<'astro:config:setup'> & {
  /**
   * Internal Astro API to register file extensions as page sources.
   * @internal This is not a public API and may change without notice.
   */
  addPageExtension: (extension: string) => void;
};

/**
 * Get the renderer for TSX pages using Astro's JSX runtime.
 * This is similar to MDX's renderer.
 */
function getTsxPagesRenderer(): AstroRenderer {
  return {
    name: ASTRO_JSX_RENDERER,
    serverEntrypoint: new URL('../dist/server.js', import.meta.url),
  };
}

export interface TsxPagesOptions {
  /**
   * Extensions to register as pages.
   * @default ['.tsx', '.jsx']
   */
  extensions?: string[];

  /**
   * Enable island hydration support with client: directives.
   * @default true
   */
  islands?: boolean;

  /**
   * JSX runtime to use for pages.
   * - 'astro': Use Astro's JSX runtime (default). Supports islands but no React hooks.
   * - 'react': Use React's JSX runtime. Supports hooks but no islands.
   * @default 'astro'
   */
  jsxRuntime?: 'astro' | 'react';
}

/**
 * Astro integration that enables using TSX/JSX files as pages.
 *
 * Requires a JSX renderer integration (e.g., @astrojs/react) to be installed.
 *
 * @example
 * ```ts
 * // astro.config.mjs
 * import { defineConfig } from 'astro/config';
 * import react from '@astrojs/react';
 * import tsxPages from '@astrojs/tsx-pages';
 *
 * export default defineConfig({
 *   integrations: [react(), tsxPages()],
 * });
 * ```
 *
 * Then create pages in `src/pages/`:
 * ```tsx
 * // src/pages/about.tsx
 * export const prerender = true;
 *
 * export default function AboutPage() {
 *   return (
 *     <html>
 *       <head><title>About</title></head>
 *       <body><h1>About</h1></body>
 *     </html>
 *   );
 * }
 * ```
 *
 * With islands (hydrated components):
 * ```tsx
 * // src/pages/interactive.tsx
 * import Counter from '../components/Counter';
 *
 * export default function Page() {
 *   return (
 *     <html>
 *       <body>
 *         <Counter client:load initial={5} />
 *       </body>
 *     </html>
 *   );
 * }
 * ```
 */
export default function tsxPages(options: TsxPagesOptions = {}): AstroIntegration {
  const extensions = options.extensions ?? ['.tsx', '.jsx'];
  const enableIslands = options.islands ?? true;
  const jsxRuntime = options.jsxRuntime ?? 'astro';

  return {
    name: '@astrojs/tsx-pages',
    hooks: {
      'astro:config:setup': (params) => {
        const { addPageExtension, addRenderer, updateConfig, logger } = params as SetupHookParams & { addRenderer: (renderer: AstroRenderer) => void };

        for (const ext of extensions) {
          addPageExtension(ext);
          logger.info(`Registered ${ext} as page extension`);
        }

        if (enableIslands) {
          // Add the astro:jsx renderer for TSX pages
          addRenderer(getTsxPagesRenderer());

          updateConfig({
            vite: {
              plugins: [
                vitePluginTsxIslandsPre({ jsxRuntime }),
                vitePluginTsxIslandsPost({ jsxRuntime }),
              ],
            },
          });
          logger.info('Enabled island hydration support');
        }
      },
      'astro:config:done': ({ config, logger }) => {
        // Check if a JSX renderer is configured
        const hasJsxRenderer = config.integrations.some(
          (integration) =>
            integration.name === '@astrojs/react' ||
            integration.name === '@astrojs/preact' ||
            integration.name === '@astrojs/solid-js'
        );

        if (!hasJsxRenderer) {
          logger.warn(
            'No JSX renderer integration found. TSX pages require @astrojs/react, @astrojs/preact, or @astrojs/solid-js to be installed.'
          );
        }
      },
    },
  };
}
