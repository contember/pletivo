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
import { transform, parse } from "@astrojs/compiler";
import { is } from "@astrojs/compiler/utils";
import type { Node } from "@astrojs/compiler/types";
import { readImageDimensions, registerImportedImage } from "./image";
import { applyDevCacheBust, getDevVersion } from "./dev-cache";

let registered = false;

/**
 * Scoped CSS collected from `<style>` blocks in `.astro` files.
 * The Astro compiler returns scoped (`:where(.astro-xxxx)`) CSS in
 * `result.css[]` and the component's scope hash in `result.scope`.
 *
 * Keyed by the component's module id (the relative path the Astro
 * compiler is given as `filename`, which matches the `moduleId` passed
 * to `$$createComponent`). We store the scope so `getScopedCssForPage()`
 * can match by scope class in the HTML — not just by CSS content. This
 * is essential because some CSS rules (e.g. `body`, `html`, `*`)
 * are NOT scoped by the compiler even though the component's
 * elements receive the scope class attribute.
 */
interface ScopedCssEntry {
  scope: string; // e.g. "jn3ixs4m" → class "astro-jn3ixs4m"
  css: string[];
}
const scopedCssMap = new Map<string, ScopedCssEntry>();

/**
 * Global CSS collected from `<style is:global>` blocks in `.astro` files.
 * Keyed by the same module id as `scopedCssMap`. Unlike scoped CSS,
 * global CSS can't be gated by scope-class presence — an `is:global`
 * block may not emit any scoped DOM at all. Instead, emission is gated
 * by whether the component was actually rendered on the page, tracked
 * at render time via the shim's rendered-module registry.
 */
const globalCssMap = new Map<string, string[]>();

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
  for (const entry of scopedCssMap.values()) {
    parts.push(...entry.css);
  }
  return parts.join("\n");
}

/**
 * Return scoped CSS entries for components actually rendered on a page.
 *
 * Matching is done by scope class: if `astro-{scope}` appears anywhere
 * in the page HTML (as a class attribute on an element), ALL CSS entries
 * from that component are included — even rules that the compiler didn't
 * scope (e.g. `body`, `html`, `*` selectors). This prevents unscoped
 * rules from being silently dropped.
 *
 * Pass the set of `astro-XXXXX` class names extracted from the page HTML.
 */
export function getScopedCssForPage(astroClasses: Set<string>): string {
  if (astroClasses.size === 0) return "";
  const parts: string[] = [];
  for (const entry of scopedCssMap.values()) {
    const scopeClass = `astro-${entry.scope}`;
    if (astroClasses.has(scopeClass)) {
      parts.push(...entry.css);
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

/**
 * Return global CSS for components actually rendered on a page.
 * `renderedModules` contains the `moduleId` values passed to
 * `$$createComponent` for each component whose render function ran
 * during this page's render pass (populated by the shim).
 */
export function getGlobalCssForPage(renderedModules: Set<string>): string {
  if (renderedModules.size === 0) return "";
  const parts: string[] = [];
  for (const [modulePath, css] of globalCssMap.entries()) {
    if (renderedModules.has(modulePath)) {
      parts.push(...css);
    }
  }
  return parts.join("\n");
}

export function clearGlobalCss(): void {
  globalCssMap.clear();
}

/**
 * Classify each entry in the compiler's `result.css[]` as scoped or
 * global by matching it to its originating `<style>` block in the
 * source. The compiler emits one entry per `<style>` block in source
 * order, so we walk the source's style tags and read each one's
 * `is:global` attribute.
 *
 * Source-based classification is more robust than inspecting the CSS
 * text for a `:where(.astro-{scope})` marker: the compiler omits that
 * marker for selectors it can't scope (e.g. `body`, `html`, `:root`),
 * which would otherwise misclassify non-global rules as global.
 */
export async function classifyCompilerCss(
  css: string[],
  source: string,
): Promise<{ scoped: string[]; global: string[] }> {
  const { ast } = await parse(source);
  const scoped: string[] = [];
  const global: string[] = [];
  let i = 0;

  const visit = (node: Node): void => {
    if (is.element(node) && node.name === "style") {
      // The compiler omits `result.css[]` entries for blocks that compile
      // to nothing (empty, whitespace-only, or comment-only). Skip those
      // so our 1:1 pairing with `css[i]` stays aligned.
      const text = node.children.filter(is.text).map((c) => c.value).join("");
      if (text.replace(/\/\*[\s\S]*?\*\//g, "").trim().length === 0) return;
      if (i >= css.length) {
        throw new Error(
          `[pletivo-astro] classifyCompilerCss: more non-empty <style> blocks than css entries (${css.length}). ` +
            `The @astrojs/compiler output contract may have changed.`,
        );
      }
      const isGlobal = node.attributes.some((a) => a.name === "is:global");
      (isGlobal ? global : scoped).push(css[i++]);
      return;
    }
    if (is.parent(node)) for (const child of node.children) visit(child);
  };
  visit(ast);

  if (i !== css.length) {
    throw new Error(
      `[pletivo-astro] classifyCompilerCss: ${i} non-empty <style> block(s) but ${css.length} css entries. ` +
        `The @astrojs/compiler output contract may have changed.`,
    );
  }
  return { scoped, global };
}

export async function registerAstroPlugin(): Promise<void> {
  if (registered) return;
  registered = true;

  const pletivoSrcDir = path.dirname(fileURLToPath(import.meta.url));
  const shimPath = path.resolve(pletivoSrcDir, "runtime/astro-shim.ts");
  const contentPath = path.resolve(pletivoSrcDir, "content/index.ts");
  const i18nVirtualPath = path.resolve(pletivoSrcDir, "i18n/virtual-module.ts");
  const imagePath = path.resolve(pletivoSrcDir, "image.ts");
  // Zod is a dep of pletivo; resolve from pletivo's package context.
  const zodPath = require.resolve("zod", { paths: [pletivoSrcDir] });

  if (process.env.PLETIVO_DEBUG) console.log("[pletivo-astro] registering plugin, shim:", shimPath);

  await Bun.plugin({
    name: "pletivo-astro",
    setup(build) {
      if (process.env.PLETIVO_DEBUG) console.log("[pletivo-astro] plugin setup running");

      // ── .astro loader ──
      // Filter needs to allow dev-mode cache-buster query strings (?v=N)
      // that pletivo's dev server appends to force module re-import.
      build.onLoad({ filter: /\.astro(\?.*)?$/ }, async (args) => {
        if (process.env.PLETIVO_DEBUG) console.log("[pletivo-astro] onLoad:", args.path);
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

        // Clear this file's previous contributions before re-populating.
        // Without this, entries linger across dev recompiles when the
        // user removes a `<style>` or `<script>` block: the compiler
        // stops emitting it but our maps still hold the old entry, so
        // stale CSS/scripts keep landing on pages until restart.
        scopedCssMap.delete(rel);
        globalCssMap.delete(rel);
        const scriptPrefix = `${rel}?astro&type=script&index=`;
        for (const id of hoistedScriptMap.keys()) {
          if (id.startsWith(scriptPrefix)) hoistedScriptMap.delete(id);
        }

        // Collect CSS emitted by the Astro compiler. Each `result.css[]`
        // entry is the compiled output of one `<style>` block. Scoped
        // blocks contain `:where(.astro-{scope})` selectors; `is:global`
        // blocks are emitted as-is (no scope selector). We split them:
        // scoped entries go to `scopedCssMap` (class-presence gated),
        // global entries go to `globalCssMap` (render-gated).
        if (result.css && result.css.length > 0) {
          const scope = (result as unknown as { scope?: string }).scope ?? "";
          const { scoped, global } = await classifyCompilerCss(result.css, source);
          if (scoped.length > 0) {
            scopedCssMap.set(rel, { scope, css: scoped });
          }
          if (global.length > 0) {
            globalCssMap.set(rel, global);
          }
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
        // CSS content is already captured above via `result.css`. Multiple
        // <style> blocks produce back-to-back imports on a single line, so
        // the regex must not require each to be on its own line.
        let cleanedCode = result.code.replace(
          /import\s+['"][^'"]*\?astro&type=style[^'"]*['"];?/g,
          "",
        );

        // In dev mode, append a version query to .astro/.scss/.sass import
        // specifiers so that Bun's module cache is busted for transitive
        // imports (not just the top-level page). Without this, editing a
        // child component or a stylesheet doesn't cause it to be re-loaded.
        cleanedCode = applyDevCacheBust(cleanedCode, getDevVersion());

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
      // from the project's own `node_modules/astro` so pletivo doesn't
      // need Astro as a dep.
      mod("astro:components", () => ({
        loader: "ts",
        contents: `export * from "astro/components";`,
      }));

      // `astro:i18n` — re-export from the pletivo runtime module. The
      // backing module reads from runtime state that dev/build install
      // after loading the user's astro.config.*, so all .astro pages
      // that `import { ... } from "astro:i18n"` share the same view.
      mod("astro:i18n", () => ({
        loader: "ts",
        contents: `export * from ${JSON.stringify(i18nVirtualPath)};`,
      }));

      // `astro:assets` — image optimization pipeline. Provides
      // `getImage()` and `imageConfig` that Astro's `<Image>` and
      // `<Picture>` components import, plus re-exports the components
      // themselves for convenience.
      mod("astro:assets", () => ({
        loader: "ts",
        contents: `
          export { getImage, imageConfig } from ${JSON.stringify(imagePath)};
          export { default as Image } from "astro/components/Image.astro";
          export { default as Picture } from "astro/components/Picture.astro";
          export type LocalImageProps = Record<string, unknown>;
          export type RemoteImageProps = Record<string, unknown>;
        `,
      }));

      // `mrmime` — MIME type lookup. Astro's `Picture.astro` imports
      // this to map image formats to MIME types. Provide a shim so
      // the package doesn't need to be installed.
      mod("mrmime", () => ({
        loader: "js",
        contents: `
          const types = {
            '.avif': 'image/avif',
            '.gif': 'image/gif',
            '.heic': 'image/heic',
            '.heif': 'image/heif',
            '.jpeg': 'image/jpeg',
            '.jpg': 'image/jpeg',
            '.png': 'image/png',
            '.svg': 'image/svg+xml',
            '.tiff': 'image/tiff',
            '.webp': 'image/webp',
          };
          export function lookup(path) {
            if (!path) return undefined;
            const dot = path.lastIndexOf('.');
            if (dot === -1) return undefined;
            return types[path.slice(dot).toLowerCase()];
          }
        `,
      }));

      // ── Image file loader ──
      // Intercept ESM imports of image files (e.g. `import hero from
      // './hero.png'`) and return an ImageMetadata object with
      // dimensions read from the file header.
      // Vite-style `?raw` / `?inline` imports return the file content
      // as a default-exported string instead of image metadata.
      build.onLoad(
        { filter: /\.(png|jpe?g|webp|avif|gif|tiff|svg)(\?.*)?$/ },
        async (args) => {
          const cleanPath = args.path.replace(/\?.*$/, "");

          // ?raw or ?inline → return file content as string
          if (/\?(raw|inline)\b/.test(args.path)) {
            const text = await Bun.file(cleanPath).text();
            return {
              contents: `export default ${JSON.stringify(text)};`,
              loader: "js",
            };
          }

          const dims = await readImageDimensions(cleanPath);
          const hasher = new Bun.CryptoHasher("md5");
          hasher.update(await Bun.file(cleanPath).arrayBuffer());
          const contentHash = hasher.digest("hex").slice(0, 8);
          const ext = path.extname(cleanPath);
          const base = path.basename(cleanPath, ext);
          const src = `/_astro/${base}.${contentHash}${ext}`;
          const outputPath = `_astro/${base}.${contentHash}${ext}`;
          // Register so the file is copied to dist even if getImage()
          // is never called (e.g. `<img src={photo.src}>`).
          registerImportedImage(cleanPath, outputPath);
          return {
            contents: `
              const meta = ${JSON.stringify({ src, width: dims.width, height: dims.height, format: dims.format })};
              Object.defineProperty(meta, 'fsPath', { value: ${JSON.stringify(cleanPath)}, enumerable: false });
              export default meta;
            `,
            loader: "js",
          };
        },
      );

      // `astro:env/client` and `astro:env/server` — type-safe env vars.
      // For SSG, both are resolved at build time from process.env.
      // The schema in astro.config defines which vars exist; the modules
      // re-export them so `import { X } from "astro:env/client"` works.
      mod("astro:env/client", () => ({
        loader: "ts",
        contents: generateEnvModule("client"),
      }));
      mod("astro:env/server", () => ({
        loader: "ts",
        contents: generateEnvModule("server"),
      }));

      // `astro/config` — minimal shim so astro.config.mjs files that
      // `import { defineConfig } from "astro/config"` can be loaded
      // without having astro installed as a dependency. `defineConfig`
      // is an identity helper in Astro (`<T>(cfg: T): T => cfg`), so
      // our shim matches exactly. Also exports `envField` as a noop
      // collector since some configs use it at top level.
      mod("astro/config", () => ({
        loader: "ts",
        contents: `
          export function defineConfig(config) { return config; }
          export function getViteConfig(config) { return config; }
          export const envField = new Proxy({}, {
            get(_target, type) {
              // envField.string({...}), envField.number({...}), envField.boolean({...}), envField.enum({...})
              return (opts = {}) => ({ ...opts, type: String(type) });
            },
          });
          export function sharpImageService() { return {}; }
          export function squooshImageService() { return {}; }
          export function passthroughImageService() { return {}; }
        `,
      }));
    },
  });
}

// ── astro:env support ──────────────────────────────────────────────

/** Env schema fields recorded by envField helpers in astro.config. */
const envSchema: Array<{ name: string; context: string; access: string }> = [];

/** Store env schema from Astro config for virtual module generation. */
export function setEnvSchema(schema: Record<string, unknown> | undefined): void {
  envSchema.length = 0;
  if (!schema || typeof schema !== "object") return;
  for (const [name, def] of Object.entries(schema)) {
    if (def && typeof def === "object") {
      const d = def as Record<string, unknown>;
      envSchema.push({
        name,
        context: (d.context as string) ?? "server",
        access: (d.access as string) ?? "secret",
      });
    }
  }
}

/**
 * Generate a virtual module that exports env vars for the given context.
 * For SSG all vars are available at build time from process.env.
 */
function generateEnvModule(context: "client" | "server"): string {
  const exports: string[] = [];
  for (const field of envSchema) {
    if (field.context === context || context === "server") {
      exports.push(
        `export const ${field.name} = process.env[${JSON.stringify(field.name)}] ?? import.meta.env?.[${JSON.stringify(field.name)}] ?? undefined;`,
      );
    }
  }
  // Even if no schema fields match, export an empty module to avoid import errors
  if (exports.length === 0) {
    return "// No env fields defined for this context\nexport {};";
  }
  return exports.join("\n");
}
