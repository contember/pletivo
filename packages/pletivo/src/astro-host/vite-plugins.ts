/**
 * Vite plugin host.
 *
 * Collects plugins registered by integrations (via `updateConfig({ vite:
 * { plugins } })`) and wires their relevant hooks into pletivo:
 *
 *  - `resolveId` + `load` → registered as Bun plugin `onResolve` / `onLoad`
 *    so bare specifiers like `virtual:cms-manifest` can be imported from
 *    anywhere at runtime (editor bundle, integration code, etc.).
 *  - `configureServer` → called once after the server shim is created.
 *  - `transformIndexHtml` → used by the server shim's own
 *    `transformIndexHtml(url, html)` method.
 *  - `transform` → not forwarded in MVP. Bun already handles TS/JSX and
 *    our Astro loader handles .astro; most Vite transforms integrate at
 *    levels pletivo bypasses.
 */

import { createHash } from "crypto";
import fs from "fs/promises";
import path from "path";
import { pathToFileURL } from "url";
import type { Loader } from "bun";
import type { ServerShim } from "@pletivo/core/astro-host/server-shim";
import type { LoadResult, ResolveIdResult, ViteLikePlugin } from "@pletivo/core/astro-host/types";

let bunPluginRegistered = false;
const collectedPlugins: ViteLikePlugin[] = [];
let projectRootForVirtualModules = process.cwd();
const tsTranspiler = new Bun.Transpiler({ loader: "ts" });

export function configureVitePluginHost(projectRoot: string): void {
  projectRootForVirtualModules = projectRoot;
}

/**
 * Register all previously-collected plugins with Bun's module loader.
 * Idempotent: the Bun plugin is registered exactly once; subsequent calls
 * just ensure newly-added Vite plugins participate in resolution.
 */
export async function ensureBunPlugin(): Promise<void> {
  if (bunPluginRegistered) return;
  bunPluginRegistered = true;

  await Bun.plugin({
    name: "pletivo-vite-plugin-host",
    setup(build) {
      // onResolve: walk Vite plugins' resolveId hooks. First plugin to
      // return a string wins. Returned id may be prefixed with `\0` by
      // Vite convention (virtual modules) — we stash it in our own
      // namespace so Bun doesn't re-resolve it as a file path.
      //
      // Filter is restricted to the specifier prefixes that Vite plugins
      // typically intercept (virtual modules, dev `/@...` paths). A
      // catch-all filter makes every normal file import run through an
      // async callback, and Bun's module loader currently cannot await
      // plugin resolutions during root imports ("onResolve() doesn't
      // support pending promises yet"). Scoping the filter sidesteps
      // that limitation and costs us nothing — Vite plugins never
      // resolve bare filesystem paths.
      build.onResolve(
        { filter: /^(virtual:|\/@|@id\/|\0virtual:)/ },
        async (args) => {
          const resolved = await resolveViteId(args.path, args.importer);
          if (resolved) {
            return {
              path: resolved,
              namespace: "pletivo-vite-virtual",
            };
          }
          return undefined;
        },
      );

      build.onLoad(
        { filter: /.*/, namespace: "pletivo-vite-virtual" },
        async (args) => {
          const loaded = await loadViteId(args.path);
          if (loaded) {
            return { contents: loaded.code, loader: loaded.loader };
          }
          return undefined;
        },
      );
    },
  });
}

/**
 * Add a batch of plugins to the host. Returns the list of plugins that
 * were actually added (new ones, de-duped by identity).
 */
/** Name-based membership test — the only handle a re-run hook's fresh plugin object gives us. */
export function hasVitePluginNamed(name: string | undefined): boolean {
  if (!name) return false;
  return collectedPlugins.some((p) => p?.name === name);
}

export function addVitePlugins(plugins: ViteLikePlugin[]): ViteLikePlugin[] {
  const added: ViteLikePlugin[] = [];
  for (const p of plugins) {
    if (!p || typeof p !== "object") continue;
    if (collectedPlugins.includes(p)) continue;
    collectedPlugins.push(p);
    added.push(p);
  }
  return added;
}

/**
 * Bun's runtime importer does not run `onResolve` for bare specifiers
 * such as `virtual:astro-icon`. Astro-compiled modules can still contain
 * those imports, so materialize matching Vite virtual modules into a
 * generated file and rewrite the import before Bun sees the module graph.
 */
export async function materializeViteVirtualImports(
  code: string,
  importerPath: string,
): Promise<string> {
  if (collectedPlugins.length === 0) return code;

  const specifiers = findVirtualSpecifiers(code);
  if (specifiers.length === 0) return code;

  const replacements = new Map<string, string>();
  for (const specifier of specifiers) {
    const filePath = await materializeViteVirtualModule(specifier, importerPath);
    if (filePath) replacements.set(specifier, pathToFileURL(filePath).href);
  }
  if (replacements.size === 0) return code;

  return code.replace(/(["'])([^"']+)\1/g, (match, quote: string, specifier: string) => {
    const replacement = replacements.get(specifier);
    return replacement ? `${quote}${replacement}${quote}` : match;
  });
}

function findVirtualSpecifiers(code: string): string[] {
  const out = new Set<string>();
  try {
    for (const entry of tsTranspiler.scanImports(code)) {
      if (isViteVirtualSpecifier(entry.path)) out.add(entry.path);
    }
  } catch {
    for (const match of code.matchAll(/["']((?:virtual:|\/@|@id\/|\0virtual:)[^"']+)["']/g)) {
      out.add(match[1]);
    }
  }
  return [...out];
}

function isViteVirtualSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith("virtual:") ||
    specifier.startsWith("/@") ||
    specifier.startsWith("@id/") ||
    specifier.startsWith("\0virtual:")
  );
}

async function materializeViteVirtualModule(
  specifier: string,
  importerPath: string,
): Promise<string | null> {
  const resolvedId = await resolveViteId(specifier, importerPath);
  const loaded = await loadViteId(resolvedId ?? specifier);
  if (!loaded) {
    if (resolvedId && path.isAbsolute(resolvedId) && await Bun.file(resolvedId).exists()) {
      return resolvedId;
    }
    return null;
  }

  const hash = createHash("sha256")
    .update(specifier)
    .update("\0")
    .update(resolvedId ?? specifier)
    .update("\0")
    .update(loaded.code)
    .digest("hex")
    .slice(0, 24);
  const dir = path.join(projectRootForVirtualModules, "node_modules", ".pletivo", "virtual");
  const filePath = path.join(dir, `${hash}${extensionForLoader(loaded.loader)}`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, loaded.code);
  return filePath;
}

/**
 * One virtual module's finished body, for `pletivo prepare` to freeze.
 *
 * The same `resolveId` → `load` walk `materializeViteVirtualModule` does, without the
 * file it writes: a Worker has nowhere to put a file, so the artifact carries the text.
 * A plugin whose `load()` depends on request-time state is exactly the thing this
 * cannot serve, and it will freeze whatever that state was at prepare time — the
 * design (`docs/todos/020 §7`) names the one real instance.
 */
export async function freezeViteVirtualModule(
  specifier: string,
  importer?: string,
): Promise<{ id: string; code: string; loader: string } | null> {
  const resolvedId = await resolveViteId(specifier, importer);
  const id = resolvedId ?? specifier;
  const loaded = await loadViteId(id);
  if (loaded) return { id, code: loaded.code, loader: freezeLoaderForId(id, loaded.loader) };
  if (resolvedId && path.isAbsolute(resolvedId) && await Bun.file(resolvedId).exists()) {
    const loader = loaderForVirtualId(resolvedId);
    return {
      id: resolvedId,
      code: await Bun.file(resolvedId).text(),
      loader: freezeLoaderForId(resolvedId, loader),
    };
  }
  return null;
}

function freezeLoaderForId(id: string, fallback: Loader): string {
  const ext = path.extname(id.replace(/\0/g, "")).toLowerCase();
  if (ext === ".astro") return "astro";
  if (ext === ".css") return "css";
  if (ext === ".jsx") return "jsx";
  if (ext === ".tsx") return "tsx";
  if (ext === ".js" || ext === ".mjs") return "js";
  if (ext === ".ts" || ext === ".mts") return "ts";
  if (ext === ".json") return "json";
  return ext === "" ? fallback : `unsupported:${ext}`;
}

async function resolveViteId(specifier: string, importer?: string): Promise<string | null> {
  for (const p of collectedPlugins) {
    if (typeof p.resolveId !== "function") continue;
    try {
      const resolved = normalizeResolvedId(await p.resolveId(specifier, importer));
      if (resolved) return resolved;
    } catch {
      // fall through to next plugin
    }
  }
  return null;
}

function normalizeResolvedId(result: ResolveIdResult): string | null {
  if (typeof result === "string") return result;
  if (result && typeof result === "object" && typeof result.id === "string") return result.id;
  return null;
}

async function loadViteId(id: string): Promise<{ code: string; loader: Loader } | null> {
  for (const p of collectedPlugins) {
    if (typeof p.load !== "function") continue;
    try {
      const result = await p.load(id);
      if (result == null) continue;
      return {
        code: codeFromLoadResult(result),
        loader: loaderForVirtualId(id),
      };
    } catch (e) {
      console.error(
        `[pletivo-vite-host] ${p.name}.load failed for ${id}:`,
        (e as Error).message,
      );
    }
  }
  return null;
}

function codeFromLoadResult(result: LoadResult): string {
  return typeof result === "string" ? result : result.code;
}

function loaderForVirtualId(id: string): Loader {
  const ext = path.extname(id.replace(/\0/g, "")).toLowerCase();
  if (ext === ".css") return "css";
  if (ext === ".jsx") return "jsx";
  if (ext === ".tsx") return "tsx";
  if (ext === ".js" || ext === ".mjs") return "js";
  if (ext === ".json") return "json";
  return "ts";
}

function extensionForLoader(loader: Loader): string {
  if (loader === "css") return ".css";
  if (loader === "jsx") return ".jsx";
  if (loader === "tsx") return ".tsx";
  if (loader === "json") return ".json";
  if (loader === "js") return ".mjs";
  return ".ts";
}

/**
 * Sync the host's current plugin list onto the given server shim's
 * `__plugins` array. Called after each batch so that the server's
 * `transformIndexHtml` walks the fresh list.
 */
export function syncServerPlugins(server: ServerShim): void {
  server.__plugins.length = 0;
  server.__plugins.push(...collectedPlugins);
}

/**
 * Run `configureServer` hooks on a set of plugins against the given
 * server shim. Called during `astro:server:setup`.
 */
export async function runConfigureServer(
  plugins: ViteLikePlugin[],
  server: ServerShim,
): Promise<void> {
  for (const p of plugins) {
    if (typeof p.configureServer !== "function") continue;
    try {
      await p.configureServer(server);
    } catch (e) {
      console.error(
        `[pletivo-vite-host] ${p.name}.configureServer failed:`,
        (e as Error).message,
      );
    }
  }
}

/**
 * Bundle a virtual-URL entry point (absolute file path returned by a
 * Vite plugin's `resolveId`) using Bun.build with a plugin that chains
 * the collected Vite `transform` hooks. This lets integrations like
 * @nuasite/notes serve their overlay source — their Vite plugin both
 * resolves the virtual id and prepends a JSX pragma via `transform()`
 * — from pletivo's dev server without any Astro/Vite runtime.
 *
 * Scope is intentionally narrow: only files reached during THIS
 * Bun.build pass see the transform chain, so regular .ts/.astro
 * imports from pletivo core or user code are unaffected.
 */
export async function bundleVirtualEntry(
  entryPath: string,
  projectRoot: string,
): Promise<string | null> {
  const fs = await import("fs/promises");
  const path = await import("path");

  const transformPlugin = {
    name: "pletivo-vite-transform-chain",
    setup(build: {
      onResolve: (
        opts: { filter: RegExp },
        cb: (args: { path: string; importer: string }) =>
          { path: string; namespace?: string } | undefined,
      ) => void;
      onLoad: (
        opts: { filter: RegExp; namespace?: string },
        cb: (args: { path: string }) => Promise<{ contents: string; loader: string } | undefined>,
      ) => void;
    }) {
      // Vite-style `?inline` / `?raw` suffixes — load a file as a
      // default-exported string. Notes + CMS both inline their
      // shadow-root CSS via this pattern.
      build.onResolve({ filter: /\?(inline|raw)$/ }, (args) => {
        const match = args.path.match(/^(.+)\?(inline|raw)$/);
        if (!match) return undefined;
        const bare = match[1];
        const abs = path.isAbsolute(bare)
          ? bare
          : args.importer
            ? path.resolve(path.dirname(args.importer), bare)
            : bare;
        return { path: abs, namespace: "pletivo-inline" };
      });
      build.onLoad(
        { filter: /.*/, namespace: "pletivo-inline" },
        async (args) => {
          try {
            const text = await fs.readFile(args.path, "utf-8");
            return {
              contents: `export default ${JSON.stringify(text)};`,
              loader: "js",
            };
          } catch {
            return { contents: "export default '';", loader: "js" };
          }
        },
      );

      // Apply transforms to any JS/TS/JSX/TSX source file reached during
      // the bundle walk. We read the file, run each plugin's transform
      // hook in order, and return the final code. If no transform
      // modified the code, we still return it (letting Bun bundle it).
      build.onLoad({ filter: /\.[jt]sx?$/ }, async (args) => {
        let code: string;
        try {
          code = await fs.readFile(args.path, "utf-8");
        } catch {
          return undefined;
        }

        for (const p of collectedPlugins) {
          if (typeof p.transform !== "function") continue;
          try {
            const result = await p.transform(code, args.path);
            if (result == null) continue;
            code = typeof result === "string" ? result : result.code;
          } catch {
            // plugin error: keep the previous code, continue chain
          }
        }

        const ext = path.extname(args.path).toLowerCase();
        const loader =
          ext === ".tsx" ? "tsx" :
          ext === ".jsx" ? "jsx" :
          ext === ".ts" ? "ts" :
          "js";
        return { contents: code, loader };
      });
    },
  };

  try {
    const result = await Bun.build({
      entrypoints: [entryPath],
      format: "esm",
      minify: false,
      plugins: [transformPlugin as never],
      target: "browser",
      root: projectRoot,
    });
    if (!result.success || result.outputs.length === 0) {
      if (!result.success) {
        for (const log of result.logs) console.error(`[pletivo-vite-host] ${log}`);
      }
      return null;
    }
    return await result.outputs[0].text();
  } catch (e) {
    const err = e as Error & { errors?: unknown };
    console.error(
      `[pletivo-vite-host] bundleVirtualEntry(${entryPath}) failed:`,
      err.message,
    );
    if (err.errors) console.error("  errors:", err.errors);
    if (err.stack) console.error(err.stack);
    return null;
  }
}

/** Test/reset helper. */
export function __resetForTests(): void {
  collectedPlugins.length = 0;
  bunPluginRegistered = false;
  projectRootForVirtualModules = process.cwd();
}
