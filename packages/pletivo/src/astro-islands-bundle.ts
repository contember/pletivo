/**
 * Client bundles for Astro islands: one module per hydrated component export, one per
 * renderer client entrypoint and one for the `before-hydration` scripts, at URLs the
 * page render computes before bundling.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { BunPlugin } from "bun";
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
  /** JS source by specifier for the integrations' virtual modules, e.g. `virtual:@astrojs/vue/app`; the server render uses the same map. */
  virtualModules: Readonly<Record<string, string>>;
}

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
 * Serves the in-memory modules, keyed by the path they pretend to have in the project root,
 * and maps each virtual specifier to its module. It must run before the compile plugin,
 * whose `onLoad` reads a matching path from disk.
 */
function inMemoryPlugin(modules: ReadonlyMap<string, string>, virtualPaths: ReadonlyMap<string, string>): BunPlugin {
  return {
    name: "pletivo-astro-islands-in-memory",
    setup(build) {
      const modulePaths = exactFilter(modules.keys());
      build.onResolve({ filter: modulePaths }, (args) => ({ path: args.path }));
      if (virtualPaths.size > 0) {
        build.onResolve({ filter: exactFilter(virtualPaths.keys()) }, (args) => {
          const resolved = virtualPaths.get(args.path);
          return resolved === undefined ? undefined : { path: resolved };
        });
      }
      build.onLoad({ filter: modulePaths }, (args) => {
        const contents = modules.get(args.path);
        return contents === undefined ? undefined : { contents, loader: "js" };
      });
    },
  };
}

/** Bun's build log, with each in-memory entry named by what it stands for. */
function formatBuildLogs(logs: readonly (BuildMessage | ResolveMessage)[], labels: ReadonlyMap<string, string>): string {
  return logs
    .map((log) => {
      if (!log.position) return log.message;
      const label = labels.get(log.position.file);
      if (label !== undefined) return `${label}: ${log.message}`;
      return `${log.position.file}:${log.position.line}:${log.position.column}: ${log.message}`;
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

  const virtualPaths = new Map<string, string>();
  for (const [specifier, source] of Object.entries(options.virtualModules)) {
    const modulePath = path.join(options.projectRoot, `pletivo-virtual.${shortHash(["virtual", specifier])}.js`);
    virtualPaths.set(specifier, modulePath);
    modules.set(modulePath, source);
    labels.set(modulePath, `virtual module ${specifier}`);
  }

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
      inMemoryPlugin(modules, virtualPaths),
      preactPlugin(options.projectRoot),
      frameworkCompilePlugin({
        compilers: options.compilers,
        target: "client",
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
