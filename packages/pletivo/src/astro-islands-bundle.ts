/**
 * Client bundles for Astro islands: one module per hydrated component export, one per
 * renderer client entrypoint and one for the `before-hydration` scripts, at URLs the
 * page render computes before bundling.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { BunPlugin, Loader } from "bun";
import type { AstroRendererEntry } from "@pletivo/core/astro-host/renderers";
import type { FrameworkCompiler } from "@pletivo/core/framework-compile/types";
import type { IslandClientUrls } from "@pletivo/runtime/astro-islands/types";
import { frameworkCompilePlugin } from "./framework-compile";
import { preactResolver } from "./islands-bundle";

const ASTRO_DIR = "_astro";

export interface IslandClientUrlsOptions {
  /** The site's base path, e.g. `/` or `/docs`. */
  base: string;
  /** Contents of the scripts integrations injected at the `before-hydration` stage. */
  beforeHydrationScripts?: readonly string[];
}

/** A component export a page hydrates, as `client:component-path` and `client:component-export` name it. */
export interface AstroIslandComponent {
  /** Absolute, as the compiler resolved the import; may lack an extension. */
  componentPath: string;
  /** `default`, a named export, or a dotted path such as `react.Counter`. */
  exportName: string;
}

export interface BundleAstroIslandsOptions extends IslandClientUrlsOptions {
  projectRoot: string;
  distDir: string;
  components: readonly AstroIslandComponent[];
  renderers: readonly AstroRendererEntry[];
  compilers: readonly FrameworkCompiler[];
  /**
   * Loads an integration's virtual module, e.g. `virtual:@astrojs/vue/app`, imported from
   * `importer`; the host answers through the same Vite plugins the server render uses.
   * `null` fails the bundle, naming the specifier.
   */
  virtualModule(specifier: string, importer: string): Promise<VirtualModuleSource | null>;
}

export interface VirtualModuleSource {
  code: string;
  loader: Loader;
}

/** The specifiers Vite plugins answer, as `page-scripts.ts` routes them. */
const VIRTUAL_SPECIFIER = /^(virtual:|\/@|@id\/|\0virtual:)/;
/** Never on disk. In the project root, so a virtual module's own imports resolve from its `node_modules`. */
const VIRTUAL_DIR = "__pletivo_island_virtual__";

/** `/`, `/docs` or `/docs/` → the prefix every island URL starts with. */
function astroUrlPrefix(base: string): string {
  const trimmed = base.replace(/^\/+|\/+$/g, "");
  return trimmed === "" ? `/${ASTRO_DIR}/` : `/${trimmed}/${ASTRO_DIR}/`;
}

function shortHash(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("base64url").slice(0, 8);
}

function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function componentFile(componentPath: string, exportName: string): string {
  const name = safeName(path.basename(componentPath, path.extname(componentPath)));
  return `${name}.${shortHash(["component", componentPath, exportName])}.js`;
}

function rendererFile(rendererName: string): string {
  // Astro names the chunk after the entrypoint file; only Svelte's is `client.svelte.js`.
  const name = rendererName === "@astrojs/svelte" ? "client.svelte" : "client";
  return `${name}.${shortHash(["renderer", rendererName])}.js`;
}

/** Astro joins the stage's scripts into one module. */
function beforeHydrationSource(scripts: readonly string[] | undefined): string | null {
  return scripts && scripts.length > 0 ? scripts.join("\n") : null;
}

function beforeHydrationFile(source: string): string {
  return `before-hydration.${shortHash(["before-hydration", source])}.js`;
}

export function createIslandClientUrls(options: IslandClientUrlsOptions): IslandClientUrls {
  const prefix = astroUrlPrefix(options.base);
  const beforeHydration = beforeHydrationSource(options.beforeHydrationScripts);
  return {
    component: (componentPath, exportName) => prefix + componentFile(componentPath, exportName),
    renderer: (rendererName) => prefix + rendererFile(rendererName),
    beforeHydration: beforeHydration === null ? null : prefix + beforeHydrationFile(beforeHydration),
  };
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** Astro's hydrator reads `mod[exportName]`, or walks a dotted path from the module, so the first segment is what to export. */
function componentEntrySource(componentPath: string, exportName: string): string {
  const exported = exportName.split(".")[0];
  if (!IDENTIFIER.test(exported)) {
    throw new Error(`Cannot hydrate export "${exportName}" of ${componentPath}: not an identifier`);
  }
  return `export { ${exported} } from ${JSON.stringify(componentPath)};\n`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function exactFilter(values: Iterable<string>): RegExp {
  return new RegExp(`^(${[...values].map(escapeRegExp).join("|")})$`);
}

/**
 * Serves the in-memory entry modules, keyed by the path they pretend to have in the project
 * root, and the virtual modules their imports reach. It must run before the compile plugin,
 * whose `onLoad` reads a matching path from disk.
 */
function inMemoryPlugin(
  projectRoot: string,
  modules: ReadonlyMap<string, string>,
  virtualModule: BundleAstroIslandsOptions["virtualModule"],
  labels: Map<string, string>,
): BunPlugin {
  const virtualDir = path.join(projectRoot, VIRTUAL_DIR);
  const virtuals = new Map<string, VirtualModuleSource>();
  return {
    name: "pletivo-astro-islands-in-memory",
    setup(build) {
      const modulePaths = exactFilter(modules.keys());
      build.onResolve({ filter: modulePaths }, (args) => ({ path: args.path }));
      build.onLoad({ filter: modulePaths }, (args) => {
        const contents = modules.get(args.path);
        return contents === undefined ? undefined : { contents, loader: "js" };
      });
      build.onResolve({ filter: VIRTUAL_SPECIFIER }, async (args) => {
        const loaded = await virtualModule(args.path, args.importer);
        if (loaded === null) throw new Error(`no Vite plugin resolves or loads ${JSON.stringify(args.path)}`);
        const file = path.join(virtualDir, `${shortHash(["virtual", args.path])}${extensionFor(loaded.loader)}`);
        virtuals.set(file, loaded);
        labels.set(file, `virtual module ${args.path}`);
        return { path: file };
      });
      build.onLoad({ filter: new RegExp(`${escapeRegExp(virtualDir)}[\\\\/]`) }, (args) => {
        const loaded = virtuals.get(args.path);
        return loaded === undefined ? undefined : { contents: loaded.code, loader: loaded.loader };
      });
    },
  };
}

function extensionFor(loader: Loader): string {
  return loader === "css" || loader === "json" || loader === "jsx" || loader === "tsx" || loader === "ts" ? `.${loader}` : ".js";
}

/** Bun's build log, each line led by its level, with each in-memory entry named by what it stands for. */
function formatBuildLogs(logs: readonly (BuildMessage | ResolveMessage)[], labels: ReadonlyMap<string, string>): string {
  return logs
    .map((log) => {
      const message = `${log.level}: ${log.message}`;
      if (!log.position) return message;
      const label = labels.get(log.position.file);
      if (label !== undefined) return `${label}: ${message}`;
      return `${log.position.file}:${log.position.line}:${log.position.column}: ${message}`;
    })
    .join("\n");
}

/** Pins every preact specifier to the project's single copy, never through tsconfig `paths` (docs/todos/013). */
function preactPlugin(projectRoot: string): BunPlugin {
  let resolver: ReturnType<typeof preactResolver> | undefined;
  return {
    name: "pletivo-astro-islands-preact",
    setup(build) {
      build.onResolve({ filter: /^preact(\/.+)?$/ }, (args) => {
        resolver ??= preactResolver(projectRoot);
        const subpath = args.path.slice("preact/".length);
        return { path: args.path === "preact" ? resolver.main : resolver.subpath(subpath) };
      });
    },
  };
}

/** Writes a module at every URL `createIslandClientUrls` returns for the given components, renderers and scripts. */
export async function bundleAstroIslands(options: BundleAstroIslandsOptions): Promise<void> {
  const urls = createIslandClientUrls(options);
  const prefix = astroUrlPrefix(options.base);
  // In-memory entries named as their output files, so `naming` can keep the name.
  // They and the virtual modules sit in the project root, so their imports resolve from there.
  const modules = new Map<string, string>();
  const entrypoints: string[] = [];
  const labels = new Map<string, string>();
  const addEntry = (url: string, source: string, label: string) => {
    if (!url.startsWith(prefix)) throw new Error(`Island URL ${url} is outside ${prefix}`);
    const entryPath = path.join(options.projectRoot, url.slice(prefix.length));
    if (modules.has(entryPath)) return;
    modules.set(entryPath, source);
    entrypoints.push(entryPath);
    labels.set(entryPath, label);
  };

  for (const { componentPath, exportName } of options.components) {
    addEntry(
      urls.component(componentPath, exportName),
      componentEntrySource(componentPath, exportName),
      `island entry for export "${exportName}" of ${componentPath}`,
    );
  }
  for (const renderer of options.renderers) {
    if (renderer.clientEntrypoint === null) continue;
    addEntry(
      urls.renderer(renderer.name),
      `export { default } from ${JSON.stringify(renderer.clientEntrypoint)};\n`,
      `client entry of renderer ${renderer.name} (${renderer.clientEntrypoint})`,
    );
  }
  const beforeHydration = beforeHydrationSource(options.beforeHydrationScripts);
  if (urls.beforeHydration !== null && beforeHydration !== null) {
    addEntry(urls.beforeHydration, beforeHydration, "before-hydration scripts");
  }
  if (entrypoints.length === 0) return;

  const result = await Bun.build({
    entrypoints,
    root: options.projectRoot,
    outdir: path.join(options.distDir, ASTRO_DIR),
    naming: { entry: "[name].[ext]" },
    splitting: true,
    format: "esm",
    target: "browser",
    minify: true,
    // Bun inlines `development` otherwise, which ships React's dev build.
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    throw: false,
    plugins: [
      inMemoryPlugin(options.projectRoot, modules, options.virtualModule, labels),
      preactPlugin(options.projectRoot),
      frameworkCompilePlugin({
        compilers: options.compilers,
        target: "client",
        loadedByRuntime: false,
        // The server render already put a hydrated component's CSS on the page; client:only is not covered yet.
        onCss() {},
      }),
    ],
  });
  if (!result.success) {
    throw new Error(`Astro island bundling failed:\n${formatBuildLogs(result.logs, labels)}`);
  }
  // The server render linked the CSS a hydrated component imports; client:only is not covered yet.
  for (const output of result.outputs) {
    if (output.path.endsWith(".css")) await fs.rm(output.path, { force: true });
  }
}

// ── PROBE: bundle before the render, URLs from the bundle output (content-hashed) ──

export interface PrebundledIslandUrls {
  /** `componentPath\0exportName` → URL. */
  components: Map<string, string>;
  renderers: Map<string, string>;
  beforeHydration: string | null;
}

export function islandKey(componentPath: string, exportName: string): string {
  return `${componentPath}\0${exportName}`;
}

const ENTRY_DIR = "__pletivo_island_entries__";

export async function prebundleAstroIslands(options: BundleAstroIslandsOptions): Promise<PrebundledIslandUrls> {
  const prefix = astroUrlPrefix(options.base);
  const modules = new Map<string, string>();
  const labels = new Map<string, string>();
  const entryOf = new Map<string, { kind: "component" | "renderer" | "before-hydration"; key: string }>();
  let n = 0;
  // One directory per entry, so `[name]` stays the plain component name, as Vite's is.
  const addEntry = (name: string, source: string, label: string, kind: "component" | "renderer" | "before-hydration", key: string) => {
    const entryPath = path.join(options.projectRoot, ENTRY_DIR, String(n++), `${safeName(name)}.js`);
    modules.set(entryPath, source);
    labels.set(entryPath, label);
    entryOf.set(entryPath, { kind, key });
  };
  for (const { componentPath, exportName } of options.components) {
    addEntry(
      path.basename(componentPath, path.extname(componentPath)),
      componentEntrySource(componentPath, exportName),
      `island entry for export "${exportName}" of ${componentPath}`,
      "component",
      islandKey(componentPath, exportName),
    );
  }
  for (const renderer of options.renderers) {
    if (renderer.clientEntrypoint === null) continue;
    addEntry(
      renderer.name === "@astrojs/svelte" ? "client.svelte" : "client",
      `export { default } from ${JSON.stringify(renderer.clientEntrypoint)};\n`,
      `client entry of renderer ${renderer.name}`,
      "renderer",
      renderer.name,
    );
  }
  const beforeHydration = beforeHydrationSource(options.beforeHydrationScripts);
  if (beforeHydration !== null) addEntry("before-hydration", beforeHydration, "before-hydration scripts", "before-hydration", "");

  const urls: PrebundledIslandUrls = { components: new Map(), renderers: new Map(), beforeHydration: null };
  if (modules.size === 0) return urls;
  const outdir = path.join(options.distDir, ASTRO_DIR);
  const result = await Bun.build({
    entrypoints: [...modules.keys()],
    root: options.projectRoot,
    outdir,
    naming: { entry: "[name].[hash].[ext]" },
    splitting: true,
    format: "esm",
    target: "browser",
    minify: true,
    metafile: true,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    throw: false,
    plugins: [
      inMemoryPlugin(options.projectRoot, modules, options.virtualModule, labels),
      preactPlugin(options.projectRoot),
      frameworkCompilePlugin({ compilers: options.compilers, target: "client", loadedByRuntime: false, onCss() {} }),
    ],
  });
  if (!result.success) throw new Error(`Astro island bundling failed:\n${formatBuildLogs(result.logs, labels)}`);
  if (!result.metafile) throw new Error("PROBE: no metafile");
  for (const [outPath, entryPoint] of metafileEntryPoints(result.metafile)) {
    const entry = entryOf.get(path.resolve(options.projectRoot, entryPoint));
    // A shared chunk names the module it was split from as its entry point; an entry's CSS names the entry.
    if (!entry || !outPath.endsWith(".js")) continue;
    const url = prefix + path.basename(outPath);
    if (entry.kind === "component") urls.components.set(entry.key, url);
    else if (entry.kind === "renderer") urls.renderers.set(entry.key, url);
    else urls.beforeHydration = url;
  }
  if (urls.renderers.size !== options.renderers.filter((r) => r.clientEntrypoint !== null).length) {
    throw new Error(`PROBE: ${urls.renderers.size} renderer outputs`);
  }
  if (urls.components.size !== options.components.length) {
    throw new Error(`PROBE: ${urls.components.size} component outputs for ${options.components.length} entries`);
  }
  for (const output of result.outputs) {
    if (output.path.endsWith(".css")) await fs.rm(output.path, { force: true });
  }
  return urls;
}

/** Output path → its entry point, for every entry output in Bun's metafile. */
function metafileEntryPoints(metafile: string | object): [string, string][] {
  const meta: unknown = typeof metafile === "string" ? JSON.parse(metafile) : metafile;
  if (typeof meta !== "object" || meta === null || !("outputs" in meta)) throw new Error("PROBE: metafile without outputs");
  const outputs = meta.outputs;
  if (typeof outputs !== "object" || outputs === null) throw new Error("PROBE: metafile outputs not an object");
  const found: [string, string][] = [];
  for (const [outPath, out] of Object.entries(outputs)) {
    if (typeof out === "object" && out !== null && "entryPoint" in out && typeof out.entryPoint === "string") {
      found.push([outPath, out.entryPoint]);
    }
  }
  return found;
}
