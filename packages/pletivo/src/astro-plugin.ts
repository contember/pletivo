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
import type { BunPlugin } from "bun";
import { transform, parse } from "@astrojs/compiler";
import { is } from "@astrojs/compiler/utils";
import type { Node } from "@astrojs/compiler/types";
import { imageUrlFor, probeAndRegisterImage } from "./image";
import { registerUrlAsset } from "./url-asset";
import { applyDevCacheBust, getDevVersion, stripQuery } from "@pletivo/core/dev-cache";
import { stripTypes } from "./transpile";
import { collectCssSideEffectImports } from "./js-imported-css";
import { materializeViteVirtualImports } from "./astro-host/vite-plugins";
import { setScriptUrlResolver } from "@pletivo/runtime/script-registry";
import {
  clearAstroImportGraph,
  moduleIdFor,
  moduleOrderForEntry,
  recordAstroImports,
} from "./astro-css-order";

let registered = false;

/**
 * CSS collected from `<style>` blocks in `.astro` files.
 *
 * Keyed by the component's module id (the relative path the Astro
 * compiler is given as `filename`, which matches the `moduleId` passed
 * to `$$createComponent`). Blocks keep the compiler's `result.css[]`
 * order, which is the order they were written in, and scoped and
 * `is:global` blocks share one list: a file's blocks cascade in source
 * order, and bucketing them by kind would silently reorder them.
 *
 * Emission is gated per block, because the two kinds are visible in
 * different ways:
 *  - scoped — the component's `astro-{scope}` class is in the page HTML.
 *    Matching by class rather than by CSS content is essential: some
 *    rules (`body`, `html`, `*`) are not scoped by the compiler even
 *    though the component's elements do get the scope class.
 *  - global — the component's render function ran during the page's
 *    render pass, tracked by the shim's rendered-module registry. An
 *    `is:global` block may emit no scoped DOM at all, so class presence
 *    cannot see it.
 */
export interface AstroStyleBlock {
  global: boolean;
  css: string;
}
interface AstroCssEntry {
  scope: string; // e.g. "jn3ixs4m" → class "astro-jn3ixs4m"
  blocks: AstroStyleBlock[];
}
const astroCssMap = new Map<string, AstroCssEntry>();

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
const hoistedBundleCache = new Map<string, Uint8Array<ArrayBuffer>>();

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

export function getHoistedBundleCache(hash: string): Uint8Array<ArrayBuffer> | undefined {
  return hoistedBundleCache.get(hash);
}

export function setHoistedBundleCache(hash: string, bytes: Uint8Array<ArrayBuffer>): void {
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
export function hoistedScriptBunPlugin(): BunPlugin {
  const resolveFilter = new RegExp(`^${HOISTED_PREFIX}[a-f0-9]+$`);
  // 16-hex-char filename (matches our `Bun.hash().padStart(16,"0")` output).
  const loadFilter = /\/[a-f0-9]{16}\.js$/;
  return {
    name: "pletivo-hoisted",
    setup(build) {
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

/**
 * The `.astro` CSS a page needs, concatenated in cascade order.
 *
 * A component contributes when the page shows it: its scope class is in
 * the HTML, or its render function ran (see `astroCssMap`). Which of its
 * blocks come along is decided per block by the same two gates.
 *
 * Components are ordered by the page's static import graph rather than by
 * the order Bun's loader happened to compile them in — see
 * `astro-css-order.ts` for why that is the order the cascade requires.
 * `entryFile` is the page module the walk starts from; without it (a
 * route with no module of its own) only the fallback ordering is left.
 */
export async function getAstroCssForPage(opts: {
  entryFile?: string;
  astroClasses: Set<string>;
  renderedModules: Set<string>;
}): Promise<string> {
  const { entryFile, astroClasses, renderedModules } = opts;
  const contributions = new Map<string, string[]>();
  for (const [moduleId, entry] of astroCssMap) {
    const scoped = astroClasses.has(`astro-${entry.scope}`);
    const rendered = renderedModules.has(moduleId);
    if (!scoped && !rendered) continue;
    const css = entry.blocks
      .filter((block) => (block.global ? rendered : scoped))
      .map((block) => block.css);
    if (css.length > 0) contributions.set(moduleId, css);
  }
  if (contributions.size === 0) return "";

  const parts: string[] = [];
  for (const moduleId of await orderContributors([...contributions.keys()], entryFile, renderedModules)) {
    parts.push(...contributions.get(moduleId)!);
  }
  return parts.join("\n");
}

async function orderContributors(
  moduleIds: string[],
  entryFile: string | undefined,
  renderedModules: Set<string>,
): Promise<string[]> {
  if (moduleIds.length < 2) return moduleIds;
  const remaining = new Set(moduleIds);
  const ordered: string[] = [];
  if (entryFile) {
    for (const moduleId of await moduleOrderForEntry(entryFile)) {
      if (remaining.delete(moduleId)) ordered.push(moduleId);
    }
    if (remaining.size === 0) return ordered;
  }
  // Whatever the walk could not reach — a component imported from `.mdx`, or
  // through a specifier that does not resolve statically. Fall back to the
  // order the components rendered in, which is at least a real property of
  // this page, then to the module id, so the result never depends on the
  // order the loader happened to compile them in.
  const rendered = [...renderedModules].filter((moduleId) => remaining.has(moduleId));
  const rest = [...remaining].filter((moduleId) => !renderedModules.has(moduleId)).sort();
  return [...ordered, ...rendered, ...rest];
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

export function clearAstroCss(): void {
  astroCssMap.clear();
  clearAstroImportGraph();
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
 *
 * `blocks` is the classification the emitter uses — every block in
 * source order, each tagged with its kind. `scoped` and `global` are the
 * same data split by kind, for callers that only care about one.
 */
export async function classifyCompilerCss(
  css: string[],
  source: string,
): Promise<{ scoped: string[]; global: string[]; blocks: AstroStyleBlock[] }> {
  const { ast } = await parse(source);
  const blocks: AstroStyleBlock[] = [];
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
      const block = css[i++];
      blocks.push({ global: isGlobal, css: block });
      (isGlobal ? global : scoped).push(block);
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
  return { scoped, global, blocks };
}

export async function registerAstroPlugin(): Promise<void> {
  if (registered) return;
  registered = true;

  // The shim resolves hoisted-script ids through this, rather than importing
  // the map from here — see @pletivo/runtime/script-registry.
  setScriptUrlResolver((id) => {
    const entry = getHoistedScript(id);
    return entry ? hoistedUrl(entry.hash) : null;
  });

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
        const rel = moduleIdFor(cleanPath);

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
        astroCssMap.delete(rel);
        const scriptPrefix = `${rel}?astro&type=script&index=`;
        for (const id of hoistedScriptMap.keys()) {
          if (id.startsWith(scriptPrefix)) deleteHoistedScript(id);
        }

        // The module's imports, taken from the compiler's own output so the
        // list is the one Bun will execute. Feeds the cascade ordering of the
        // CSS collected below — see astro-css-order.ts.
        recordAstroImports(cleanPath, result.code);

        // Collect CSS emitted by the Astro compiler. Each `result.css[]`
        // entry is the compiled output of one `<style>` block, in source
        // order. Scoped blocks contain `:where(.astro-{scope})` selectors;
        // `is:global` blocks are emitted as-is (no scope selector), and the
        // two are gated differently at emission time (see `astroCssMap`).
        if (result.css && result.css.length > 0) {
          const scope = (result as unknown as { scope?: string }).scope ?? "";
          const { blocks } = await classifyCompilerCss(result.css, source);
          if (blocks.length > 0) {
            astroCssMap.set(rel, { scope, blocks });
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
