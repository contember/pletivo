/**
 * Bun plugin that teaches the runtime how to import `.astro` files.
 *
 * On each `.astro` import:
 *  - reads the source
 *  - runs `@astrojs/compiler`'s `transform()` with `internalURL` pointing at
 *    our runtime shim (`./runtime/astro-shim.ts`)
 *  - returns the generated TS code to Bun, which compiles and caches it
 *    using its native TypeScript loader
 *
 * Also registers Astro's virtual modules (`astro:content`, `astro/loaders`,
 * `astro/zod`) so content collection configs written for Astro work unchanged.
 *
 * Call `registerAstroPlugin()` once at process start — before any `.astro`
 * file is imported via `await import(...)` or `Bun.build()`.
 */

import path from "path";
import { fileURLToPath } from "url";
import { transform } from "@astrojs/compiler";

let registered = false;

/**
 * Dev-mode version counter. The dev server increments this on every file
 * change. The astro-plugin appends it as a query string to `.astro`
 * import specifiers in compiled code so that Bun's module cache is busted
 * for transitive component imports (not just the page itself).
 */
let devVersion = 0;
export function bumpDevVersion(): number {
  return ++devVersion;
}
export function getDevVersion(): number {
  return devVersion;
}

/**
 * Scoped CSS collected from `<style>` blocks in `.astro` files.
 * The Astro compiler returns scoped (`:where(.astro-xxxx)`) CSS in
 * `result.css[]`. We store it here keyed by file path so that the
 * CSS pipeline can append it to the bundled stylesheet.
 *
 * Call `getScopedCss()` to retrieve the accumulated CSS and
 * `clearScopedCss()` between builds / dev requests to avoid stale entries.
 */
const scopedCssMap = new Map<string, string[]>();

/**
 * Hoisted scripts collected from `<script>` tags (non-inline) in `.astro`
 * files. The compiler returns them in `result.scripts[]` and emits
 * `$$renderScript($$result, "file.astro?astro&type=script&index=N&lang.ts")`
 * calls in the template. We store them keyed by that virtual ID so
 * `renderScript()` in the shim can emit `<script type="module">` tags.
 */
const hoistedScriptMap = new Map<string, string>();

export function getHoistedScript(id: string): string | undefined {
  return hoistedScriptMap.get(id);
}

export function clearHoistedScripts(): void {
  hoistedScriptMap.clear();
}

export function getScopedCss(): string {
  const parts: string[] = [];
  for (const css of scopedCssMap.values()) {
    parts.push(...css);
  }
  return parts.join("\n");
}

/**
 * Return scoped CSS entries that match any of the given astro scope hashes
 * found in a page's HTML. This allows per-page CSS injection — only the
 * styles relevant to components actually rendered on that page are included.
 *
 * Pass the set of `astro-XXXXX` class names extracted from the page HTML.
 */
export function getScopedCssForPage(astroClasses: Set<string>): string {
  if (astroClasses.size === 0) return "";
  const parts: string[] = [];
  for (const cssArr of scopedCssMap.values()) {
    for (const css of cssArr) {
      // Include this entry if it contains any of the page's astro scope classes
      for (const cls of astroClasses) {
        if (css.includes(cls)) {
          parts.push(css);
          break;
        }
      }
    }
  }
  return parts.join("\n");
}

/** Extract all `astro-XXXXX` scope class names from an HTML string. */
export function extractAstroClasses(html: string): Set<string> {
  const classes = new Set<string>();
  const re = /astro-[a-z0-9]+/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    classes.add(m[0]);
  }
  return classes;
}

export function clearScopedCss(): void {
  scopedCssMap.clear();
}

export async function registerAstroPlugin(): Promise<void> {
  if (registered) return;
  registered = true;

  const pavoukSrcDir = path.dirname(fileURLToPath(import.meta.url));
  const shimPath = path.resolve(pavoukSrcDir, "runtime/astro-shim.ts");
  const contentPath = path.resolve(pavoukSrcDir, "content/index.ts");
  // Zod is a dep of pavouk; resolve from pavouk's package context.
  const zodPath = require.resolve("zod", { paths: [pavoukSrcDir] });

  if (process.env.PAVOUK_DEBUG) console.log("[pavouk-astro] registering plugin, shim:", shimPath);

  await Bun.plugin({
    name: "pavouk-astro",
    setup(build) {
      if (process.env.PAVOUK_DEBUG) console.log("[pavouk-astro] plugin setup running");

      // ── .astro loader ──
      // Filter needs to allow dev-mode cache-buster query strings (?v=N)
      // that pavouk's dev server appends to force module re-import.
      build.onLoad({ filter: /\.astro(\?.*)?$/ }, async (args) => {
        if (process.env.PAVOUK_DEBUG) console.log("[pavouk-astro] onLoad:", args.path);
        // Strip cache-buster query (`?v=N`) before filesystem read
        const cleanPath = args.path.replace(/\?.*$/, "");
        const source = await Bun.file(cleanPath).text();
        const rel = path.relative(process.cwd(), cleanPath);

        const result = await transform(source, {
          filename: rel,
          internalURL: shimPath,
          sourcemap: false,
          resolvePath: async (specifier) => specifier,
        });

        if (result.diagnostics?.some((d) => d.severity === 1)) {
          const errors = result.diagnostics
            .filter((d) => d.severity === 1)
            .map((d) => `  ${d.text}`)
            .join("\n");
          throw new Error(`Astro compiler errors in ${rel}:\n${errors}`);
        }

        // Collect scoped CSS emitted by the Astro compiler for `<style>`
        // blocks. The compiler returns the scoped rules in `result.css[]`
        // (e.g. `.foo:where(.astro-xxxx){color:red}`). We stash them so
        // the CSS pipeline can append them to the bundled stylesheet.
        if (result.css && result.css.length > 0) {
          scopedCssMap.set(cleanPath, result.css);
        }

        // Collect hoisted scripts from `<script>` tags (non-inline).
        // The compiler returns them in `result.scripts[]` and references
        // them via `$$renderScript(result, "file?astro&type=script&index=N...")`.
        if (result.scripts && result.scripts.length > 0) {
          for (let i = 0; i < result.scripts.length; i++) {
            const s = result.scripts[i] as { code?: string };
            if (s.code) {
              const scriptId = `${rel}?astro&type=script&index=${i}&lang.ts`;
              hoistedScriptMap.set(scriptId, s.code);
            }
          }
        }

        // Strip the virtual style imports that the compiler emits:
        //   import '/abs/path/File.astro?astro&type=style&index=0&lang.css';
        // Bun has no resolver for that query-suffixed specifier. The actual
        // CSS content is already captured above via `result.css`.
        let cleanedCode = result.code.replace(
          /^\s*import\s+['"][^'"]*\?astro&type=style[^'"]*['"];?\s*$/gm,
          "",
        );

        // In dev mode, append a version query to .astro import specifiers
        // so that Bun's module cache is busted for transitive component
        // imports (not just the top-level page). Without this, editing a
        // child component doesn't cause it to be re-compiled.
        if (devVersion > 0) {
          cleanedCode = cleanedCode.replace(
            /(from\s+['"])([^'"]+\.astro)(['"])/g,
            `$1$2?v=${devVersion}$3`,
          );
        }

        return {
          contents: cleanedCode,
          loader: "ts",
        };
      });

      // ── Virtual modules ──
      // Bun's default resolver rejects colon-containing specifiers (`astro:content`)
      // before our `onResolve` hook runs, so we register them via `build.module`,
      // which is Bun's dedicated virtual-module primitive and bypasses the
      // URL-scheme validation.
      const mod = (build as unknown as {
        module: (
          specifier: string,
          callback: () => { contents: string; loader: string },
        ) => void;
      }).module;

      mod("astro:content", () => ({
        loader: "ts",
        contents: `
          export {
            getCollection,
            getEntry,
            defineCollection,
            reference,
            render,
            z,
          } from ${JSON.stringify(contentPath)};
        `,
      }));

      mod("astro/loaders", () => ({
        loader: "ts",
        contents: `export { glob } from ${JSON.stringify(contentPath)};`,
      }));

      mod("astro/zod", () => ({
        loader: "ts",
        contents: `export { z } from ${JSON.stringify(zodPath)}; export * from ${JSON.stringify(zodPath)};`,
      }));

      // `astro:components` — re-export the batch of .astro components
      // that ship with Astro itself (<Code>, <Debug>, <Font>, <Image>,
      // <Picture>, <ClientRouter>, …). These are real .astro files in
      // `astro/components/` and our .astro loader above compiles them
      // the same as user components. The re-export is resolved lazily
      // from the project's own `node_modules/astro` so pavouk doesn't
      // need Astro as a dep.
      mod("astro:components", () => ({
        loader: "ts",
        contents: `export * from "astro/components";`,
      }));
    },
  });
}
