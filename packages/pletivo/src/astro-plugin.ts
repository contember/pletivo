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
import { imageUrlFor, probeAndRegisterImage } from "./image";
import { registerUrlAsset } from "./url-asset";
import { applyDevCacheBust, getDevVersion, stripQuery } from "./dev-cache";
import { stripTypes } from "./transpile";
import { collectCssSideEffectImports } from "./js-imported-css";
import { materializeViteVirtualImports } from "./astro-host/vite-plugins";

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
 * files. The Astro compiler emits `$$renderScript(result, "<rel>?astro&type=script&index=N&lang.ts")`
 * calls and we key entries by that virtual id. `sourceFile` is needed
 * because the body may contain relative imports that must resolve
 * against the originating directory; `hash` is the public URL slug.
 */
export interface HoistedScriptEntry {
  code: string;
  sourceFile: string;
  hash: string;
}
const hoistedScriptMap = new Map<string, HoistedScriptEntry>();
const hoistedScriptByHash = new Map<string, HoistedScriptEntry>();
/** Bun.build outputs cached by hash, populated by the dev route on first hit. */
const hoistedBundleCache = new Map<string, Uint8Array>();

/** Specifier used as the Bun.build entrypoint for hoisted scripts. */
const HOISTED_PREFIX = "pletivo:hoisted:";
/** Public URL path prefix for hoisted-script bundles. */
export const HOISTED_URL_PATH = "/_astro/hoisted-";
/** Capture group is the hex hash. Not anchored — works under any base prefix. */
export const HOISTED_URL_RE = /\/_astro\/hoisted-([a-f0-9]+)\.js/g;

export function hoistedEntrypoint(hash: string): string {
  return HOISTED_PREFIX + hash;
}
export function hoistedUrl(hash: string): string {
  return `${HOISTED_URL_PATH}${hash}.js`;
}

function setHoistedScript(id: string, entry: HoistedScriptEntry): void {
  hoistedScriptMap.set(id, entry);
  hoistedScriptByHash.set(entry.hash, entry);
}

function deleteHoistedScript(id: string): void {
  const entry = hoistedScriptMap.get(id);
  if (entry) {
    hoistedScriptByHash.delete(entry.hash);
    hoistedBundleCache.delete(entry.hash);
  }
  hoistedScriptMap.delete(id);
}

/**
 * Build the virtual id under which a `<script>` block from `rel` (relative
 * `.astro` path) at the given index is stored. Mirrors the format the
 * Astro compiler emits inside `$$renderScript()` calls.
 */
export function hoistedScriptId(rel: string, index: number): string {
  return `${rel}?astro&type=script&index=${index}&lang.ts`;
}

export function getHoistedScript(id: string): HoistedScriptEntry | undefined {
  return hoistedScriptMap.get(id);
}

export function getHoistedScriptByHash(hash: string): HoistedScriptEntry | undefined {
  return hoistedScriptByHash.get(hash);
}

export function getAllHoistedScripts(): HoistedScriptEntry[] {
  return Array.from(hoistedScriptMap.values());
}

export function clearHoistedScripts(): void {
  hoistedScriptMap.clear();
  hoistedScriptByHash.clear();
  hoistedBundleCache.clear();
}

export function getHoistedBundleCache(hash: string): Uint8Array | undefined {
  return hoistedBundleCache.get(hash);
}

export function setHoistedBundleCache(hash: string, bytes: Uint8Array): void {
  hoistedBundleCache.set(hash, bytes);
}

/**
 * Bun.build plugin that resolves `pletivo:hoisted:<hash>` entrypoints
 * to a virtual file inside the originating `.astro` file's directory,
 * so relative imports in the script body (`import '../scripts/x.js'`)
 * resolve against the right base. The virtual path never exists on
 * disk — `onLoad` short-circuits the read. Bun derives the output
 * basename from the entrypoint specifier (not the resolved path), so
 * callers must rename `pletivo:hoisted:<hash>.js` outputs themselves.
 */
export function hoistedScriptBunPlugin() {
  const resolveFilter = new RegExp(`^${HOISTED_PREFIX}[a-f0-9]+$`);
  // 16-hex-char filename (matches our `Bun.hash().padStart(16,"0")` output).
  const loadFilter = /\/[a-f0-9]{16}\.js$/;
  return {
    name: "pletivo-hoisted",
    setup(build: {
      onResolve: (
        opts: { filter: RegExp },
        cb: (args: { path: string }) => { path: string } | undefined,
      ) => void;
      onLoad: (
        opts: { filter: RegExp },
        cb: (args: { path: string }) => { contents: string; loader: string } | undefined,
      ) => void;
    }) {
      build.onResolve({ filter: resolveFilter }, (args) => {
        const hash = args.path.slice(HOISTED_PREFIX.length);
        const entry = hoistedScriptByHash.get(hash);
        if (!entry) return undefined;
        return {
          path: path.join(path.dirname(entry.sourceFile), `${hash}.js`),
        };
      });
      build.onLoad({ filter: loadFilter }, (args) => {
        const m = args.path.match(/\/([a-f0-9]{16})\.js$/);
        if (!m) return undefined;
        const entry = hoistedScriptByHash.get(m[1]);
        if (!entry) return undefined;
        return { contents: entry.code, loader: "js" };
      });
    },
  };
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
  const containerPath = path.resolve(pletivoSrcDir, "runtime/astro-container.ts");
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
        const cleanPath = stripQuery(args.path);
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
          if (id.startsWith(scriptPrefix)) deleteHoistedScript(id);
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

        if (result.scripts && result.scripts.length > 0) {
          for (let i = 0; i < result.scripts.length; i++) {
            const s = result.scripts[i];
            if (s.type === "inline") {
              const code = stripTypes(s.code);
              const hash = Bun.hash(`${cleanPath}\0${i}\0${code}`)
                .toString(16)
                .padStart(16, "0");
              setHoistedScript(hoistedScriptId(rel, i), {
                code,
                sourceFile: cleanPath,
                hash,
              });
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
        cleanedCode = await materializeViteVirtualImports(cleanedCode, cleanPath);
        await collectCssSideEffectImports(cleanPath, cleanedCode, `astro:${rel}`);

        // In dev mode, append a version query to .astro/.scss/.sass/.json
        // import specifiers so that Bun's module cache is busted for
        // transitive imports (not just the top-level page). Without this,
        // editing a child component, stylesheet, or translation dictionary
        // doesn't cause it to be re-loaded.
        cleanedCode = applyDevCacheBust(cleanedCode, getDevVersion());

        return {
          contents: cleanedCode,
          loader: "ts",
        };
      });

      // ── `?url` imports ──
      // `import href from "./foo.js?url"` resolves to the asset's URL string
      // (Astro/Vite semantics) — the file is served/emitted as-is, not loaded as
      // a module. Without this Bun loads `foo.js?url` as JS and throws on the
      // missing default export. Registered before the image loader so `?url`
      // wins for every file type, including images.
      build.onLoad({ filter: /\?url$/ }, async (args) => {
        const cleanPath = stripQuery(args.path);
        const href = await registerUrlAsset(cleanPath);
        return {
          contents: `export default ${JSON.stringify(href)};`,
          loader: "js",
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
        { filter: /\.(png|jpe?g|webp|avif|gif|tiff|svg)(\?.*)?$/i },
        async (args) => {
          const cleanPath = stripQuery(args.path);

          // ?raw or ?inline → return file content as string
          if (/\?(raw|inline)\b/.test(args.path)) {
            const text = await Bun.file(cleanPath).text();
            return {
              contents: `export default ${JSON.stringify(text)};`,
              loader: "js",
            };
          }

          const probe = await probeAndRegisterImage(cleanPath);
          const src = imageUrlFor(cleanPath, probe.outputPath);
          const visible = { src, width: probe.width, height: probe.height, format: probe.format };
          return {
            contents: `
              const meta = ${JSON.stringify(visible)};
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

      // `astro/container` — experimental Container API shim. Lets
      // integrations render `.astro` components directly (typically
      // from `astro:build:done` hooks for post-build artifacts).
      // Backed by the renderer in `runtime/astro-container.ts`.
      mod("astro/container", () => ({
        loader: "ts",
        contents: `export { experimental_AstroContainer } from ${JSON.stringify(containerPath)};`,
      }));

      // `astro/config` — this Bun plugin is global, so the registration below
      // also shadows `astro/config` for the `await import()` that loads the
      // user's astro.config.*. Adapters/integrations pulled in there import a
      // growing surface from `astro/config` (e.g. `@astrojs/cloudflare` imports
      // `sessionDrivers`), which a hand-written shim can't keep up with. So when
      // astro is installed in the project, re-export the *real* `astro/config`
      // — the config then loads exactly as it would under Astro. The minimal
      // shim remains a fallback for projects without astro as a dependency
      // (`defineConfig`/`getViteConfig` are identity helpers; `envField` a noop
      // collector; the image-service helpers return empty descriptors).
      mod("astro/config", () => {
        let realConfig: string | null = null;
        try {
          realConfig = Bun.resolveSync("astro/config", process.cwd());
        } catch {
          realConfig = null;
        }
        if (realConfig) {
          return {
            loader: "ts",
            contents: `export * from ${JSON.stringify(realConfig)};`,
          };
        }
        return {
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
        };
      });
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
