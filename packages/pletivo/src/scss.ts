/**
 * SCSS/Sass support for Pletivo.
 *
 * Registers a Bun plugin that handles `.scss` / `.sass` side-effect imports
 * (e.g. `import '../styles/style.scss'` from a layout or component):
 *  - resolves the project's `sass` package (user-owned, not a pletivo dep)
 *  - compiles the file with `sass.compile()`
 *  - stores the generated CSS keyed by source path
 *  - returns an empty JS module so the import statement has no runtime effect
 *
 * Accumulated CSS is read by `getScssOutput()` and merged into the CSS
 * bundle (build) / `/__styles.css` response (dev).
 *
 * Partial files (starting with `_`) are NEVER compiled as standalone
 * entries — they're only consumed via `@use` / `@import` from the entry
 * that the user actually imports from a component.
 */

import path from "path";

let registered = false;

/** Map of source absolute path → compiled CSS string */
const scssOutputMap = new Map<string, string>();

/** Scss compiler options (loadPaths, silenceDeprecations, style) — read from
 * `astro.config` → `vite.css.preprocessorOptions.scss`. Must be configured
 * before the first page render triggers a scss import. */
interface ScssOptions {
  loadPaths?: string[];
  silenceDeprecations?: string[];
  style?: "expanded" | "compressed";
  [key: string]: unknown;
}
let scssOptions: ScssOptions = {};
export function configureScss(options: ScssOptions | undefined): void {
  scssOptions = options ?? {};
}

/** Concatenated CSS from all imported scss files (insertion order). */
export function getScssOutput(): string {
  if (scssOutputMap.size === 0) return "";
  return Array.from(scssOutputMap.values()).join("\n");
}

/** Clear accumulated scss (between builds). */
export function clearScss(): void {
  scssOutputMap.clear();
}

type SassModule = {
  compile: (
    path: string,
    options?: Record<string, unknown>,
  ) => { css: string; loadedUrls?: URL[] };
};

let sassModule: SassModule | null = null;
let sassResolveFailed = false;

async function loadSass(projectRoot: string): Promise<SassModule | null> {
  if (sassModule) return sassModule;
  if (sassResolveFailed) return null;
  try {
    const sassPath = require.resolve("sass", { paths: [projectRoot] });
    sassModule = (await import(sassPath)) as SassModule;
    return sassModule;
  } catch {
    sassResolveFailed = true;
    console.error(
      "[pletivo] A .scss/.sass file was imported but the `sass` package is not installed in the project. Run `bun add sass` to enable SCSS support.",
    );
    return null;
  }
}

export async function registerScssPlugin(projectRoot: string): Promise<void> {
  if (registered) return;
  registered = true;

  await Bun.plugin({
    name: "pletivo-scss",
    setup(build) {
      build.onLoad(
        { filter: /\.(scss|sass)(\?.*)?$/ },
        async (args) => {
          const cleanPath = args.path.replace(/\?.*$/, "");
          const sass = await loadSass(projectRoot);
          if (!sass) {
            return { contents: "export {};", loader: "js" };
          }

          try {
            const result = sass.compile(cleanPath, {
              loadPaths: [
                path.dirname(cleanPath),
                ...(scssOptions.loadPaths ?? []),
              ],
              silenceDeprecations: scssOptions.silenceDeprecations,
              style: scssOptions.style ?? "expanded",
            });
            scssOutputMap.set(cleanPath, result.css);
          } catch (e) {
            console.error(
              `[pletivo] scss compile failed for ${path.relative(projectRoot, cleanPath)}:`,
              (e as Error).message,
            );
            scssOutputMap.set(
              cleanPath,
              `/* scss compile error: ${(e as Error).message} */`,
            );
          }

          return { contents: "export {};", loader: "js" };
        },
      );
    },
  });
}
