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

        // Strip the virtual style imports that Astro compiler emits for
        // `<style>` blocks. They look like:
        //   import '/abs/path/File.astro?astro&type=style&index=0&lang.css';
        // Bun has no resolver for that query-suffixed specifier, and scoped
        // CSS is deferred to a future pavouk plugin anyway. For MVP we drop
        // them entirely; global `<style>` content is ignored.
        //
        // Hoisted scripts use a similar virtual path
        // (`?astro&type=script&...`) and show up as `$$renderScript(...)` in
        // the body, not as imports — so we leave them alone and the shim
        // currently no-ops them.
        const cleanedCode = result.code.replace(
          /^\s*import\s+['"][^'"]*\?astro&type=style[^'"]*['"];?\s*$/gm,
          "",
        );

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
    },
  });
}
