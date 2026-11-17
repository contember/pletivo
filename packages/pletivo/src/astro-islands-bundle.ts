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
import { compareStrings } from "@pletivo/core/compare-strings";
import type { FrameworkCompiler } from "@pletivo/core/framework-compile/types";
import {
  astroUrlPrefix,
  beforeHydrationSource,
  createIslandClientUrls,
  portableSpecifier,
  type IslandClientUrlsOptions,
} from "@pletivo/core/island-urls";
import { frameworkCompilePlugin } from "./framework-compile";
import { preactResolver } from "./islands-bundle";

const ASTRO_DIR = "_astro";

/** A component export a page hydrates, as `client:component-path` and `client:component-export` name it. */
export interface AstroIslandComponent {
  /** Absolute, as the compiler resolved a relative import, or a package specifier; may lack an extension. */
  componentPath: string;
  /** `default`, a named export, or a dotted path such as `react.Counter`. */
  exportName: string;
}

export interface BundleAstroIslandsOptions extends IslandClientUrlsOptions {
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

function shortHash(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("base64url").slice(0, 8);
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * Astro's hydrator reads `mod[exportName]`, or walks a dotted path from the module, so the first segment is what to export.
 * The entry sits in the project root; its specifier is relative because Bun's minifier picks names from the source's characters.
 */
function componentEntrySource(projectRoot: string, componentPath: string, exportName: string): string {
  const exported = exportName.split(".")[0];
  if (!IDENTIFIER.test(exported)) {
    throw new Error(`Cannot hydrate export "${exportName}" of ${componentPath}: not an identifier`);
  }
  return `export { ${exported} } from ${JSON.stringify(portableSpecifier(projectRoot, componentPath))};\n`;
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

/** Calls `beforeRead` for each file on disk, then leaves loading it to the plugins after it. */
function readTracker(beforeRead: (file: string) => Promise<void>, inMemory: (file: string) => boolean): BunPlugin {
  return {
    name: "pletivo-astro-islands-read-tracker",
    setup(build) {
      build.onLoad({ filter: /.*/, namespace: "file" }, async (args) => {
        if (!inMemory(args.path)) await beforeRead(args.path);
        return undefined;
      });
    },
  };
}

/** One module of the islands' client bundle. */
export interface AstroIslandFile {
  /** Root-absolute, under the base's `_astro/`: an island's `component-url` or `renderer-url`, or a chunk they import. */
  url: string;
  code: string;
  /**
   * What Bun's metafile lists as its inputs, resolved against the working directory, less the
   * in-memory entries and virtual modules. Bun's own browser polyfills are among them.
   */
  inputs: string[];
}

export interface BuildAstroIslandsOptions extends Omit<BundleAstroIslandsOptions, "distDir"> {
  /** Called with each file on disk before the bundle reads it: what prepare digests as its inputs. */
  beforeRead?(file: string): Promise<void>;
}

/** Writes a module at every URL `createIslandClientUrls` returns for the given components, renderers and scripts. */
export async function bundleAstroIslands(options: BundleAstroIslandsOptions): Promise<void> {
  const prefix = astroUrlPrefix(options.base);
  const outDir = path.join(options.distDir, ASTRO_DIR);
  for (const file of await buildAstroIslands(options)) {
    const out = path.join(outDir, file.url.slice(prefix.length));
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, file.code);
  }
}

/**
 * The client modules `bundleAstroIslands` writes, in memory. Its JavaScript only: the server render
 * already put a hydrated component's CSS on the page; client:only is not covered yet.
 */
export async function buildAstroIslands(options: BuildAstroIslandsOptions): Promise<AstroIslandFile[]> {
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

  // Sorted by URL: Bun's cross-chunk export names follow entry order, and the order components
  // finish rendering in is not the order a host that does not render sees them in.
  const components = options.components
    .map((component) => ({ ...component, url: urls.component(component.componentPath, component.exportName) }))
    .sort((left, right) => compareStrings(left.url, right.url));
  for (const { componentPath, exportName, url } of components) {
    addEntry(url, componentEntrySource(options.projectRoot, componentPath, exportName), `island entry for export "${exportName}" of ${componentPath}`);
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
  if (entrypoints.length === 0) return [];
  const virtualDir = path.join(options.projectRoot, VIRTUAL_DIR) + path.sep;
  const inMemory = (file: string) => modules.has(file) || file.startsWith(virtualDir);

  const result = await Bun.build({
    entrypoints,
    root: options.projectRoot,
    naming: { entry: "[name].[ext]" },
    splitting: true,
    format: "esm",
    target: "browser",
    minify: true,
    metafile: true,
    // Bun inlines `development` otherwise, which ships React's dev build.
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    throw: false,
    plugins: [
      ...(options.beforeRead === undefined ? [] : [readTracker(options.beforeRead, inMemory)]),
      inMemoryPlugin(options.projectRoot, modules, options.virtualModule, labels),
      preactPlugin(options.projectRoot),
      frameworkCompilePlugin({
        compilers: options.compilers,
        target: "client",
        loadedByRuntime: false,
        onCss() {},
      }),
    ],
  });
  if (!result.success) {
    throw new Error(`Astro island bundling failed:\n${formatBuildLogs(result.logs, labels)}`);
  }
  const files: AstroIslandFile[] = [];
  for (const output of result.outputs) {
    if (output.path.endsWith(".css")) continue;
    const name = output.path.replace(/^\.\//, "");
    const inputs = Object.keys(result.metafile?.outputs[output.path]?.inputs ?? {})
      .map((input) => path.resolve(input))
      .filter((input) => !inMemory(input));
    files.push({ url: prefix + name, code: await output.text(), inputs });
  }
  return files;
}
