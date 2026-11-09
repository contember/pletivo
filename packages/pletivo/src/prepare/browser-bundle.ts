/**
 * The browser graph's packages, bundled: a browser script loads one module per package import
 * it makes, plus the chunks those share, instead of every file of every package one import
 * round trip after another. Bundled from the artifact's own modules and resolutions, never
 * from disk, so the bundle holds exactly the graph `prepareBrowserGraph` closed and checked.
 */

import {
  BROWSER_BUNDLE_MODULE_PREFIX,
  type ArtifactModule,
  type ArtifactResolution,
  type ModuleId,
} from "@pletivo/core/artifact";
import { browserStylesheetModule } from "@pletivo/core/browser-stylesheet";
import { compareStrings } from "@pletivo/core/compare-strings";
import type { BunPlugin, Loader } from "bun";
import { prepareFailure, type PrepareError } from "./error";

const ENTRY_PREFIX = "pletivo-browser-entry-";
const NAMESPACE = "pletivo-browser-graph";
const SOURCE = "browser graph";
const HOOK = "browser bundle";
const BUNDLE_SCANNER = new Bun.Transpiler({ loader: "js" });

export interface BrowserBundle {
  /** The bundle's files, as `BROWSER_BUNDLE_MODULE_PREFIX` modules. */
  modules: ArtifactModule[];
  /** The browser graph's resolutions, answered by the bundle: script imports, then imports between its files. */
  resolutions: ArtifactResolution[];
}

/**
 * Bundle what the browser graph's script imports reach. An import written in a project file or
 * in a carried component's script is an entry; every other edge of `resolutions` ends inside
 * the bundle. Two entries reaching one module share it through a chunk, so it runs once.
 */
export async function bundleBrowserGraph(
  modules: ReadonlyMap<ModuleId, ArtifactModule>,
  resolutions: readonly ArtifactResolution[],
): Promise<BrowserBundle> {
  const scriptImports = resolutions.filter(
    (resolution) => resolution.importer.startsWith("project:") || modules.get(resolution.importer)?.kind === "astro",
  );
  const entries = [...new Set(scriptImports.map((resolution) => targetId(resolution)))].sort(compareStrings);
  if (entries.length === 0) return { modules: [], resolutions: [] };

  const byName = await build(entries, modules, resolutions);
  const entryNames = new Map(entries.map((id, index) => [id, `${ENTRY_PREFIX}${index}.js`]));
  const codeOf = (name: string): string => {
    const code = byName.get(name);
    if (code === undefined) throw prepareFailure(SOURCE, HOOK, `bundling wrote no ${name}`);
    return code;
  };

  // Only what the entries reach: a chunk split off for a dynamic import the bundle dropped is left out.
  const imports = new Map<string, string[]>();
  const reached = new Set<string>();
  const queue = [...entryNames.values()];
  while (queue.length > 0) {
    const name = queue.pop();
    if (name === undefined || reached.has(name)) continue;
    reached.add(name);
    // Bun's own scan, not `specifiersOf`: its CommonJS guards are for package sources, not for Bun's runtime helpers.
    const specifiers = [...new Set(BUNDLE_SCANNER.scanImports(codeOf(name)).map((entry) => entry.path))];
    for (const specifier of specifiers) {
      if (!specifier.startsWith("./") || !byName.has(specifier.slice(2))) {
        throw prepareFailure(SOURCE, HOOK, `${name} imports ${JSON.stringify(specifier)}, which is not a file of the bundle`);
      }
      queue.push(specifier.slice(2));
    }
    imports.set(name, specifiers);
  }

  const files = [...reached].sort(compareStrings);
  const digest = new Bun.CryptoHasher("sha256");
  for (const name of files) digest.update(`${name}\0${codeOf(name)}\0`);
  const directory = `${BROWSER_BUNDLE_MODULE_PREFIX}${digest.digest("hex").slice(0, 32)}`;
  const idOf = (name: string): ModuleId => `${directory}/${name}`;

  const bundled: ArtifactResolution[] = scriptImports.map((resolution) => ({
    importer: resolution.importer,
    specifier: resolution.specifier,
    target: { kind: "module", id: idOf(entryNameOf(entryNames, targetId(resolution))) },
  }));
  for (const name of files) {
    for (const specifier of imports.get(name) ?? []) {
      bundled.push({ importer: idOf(name), specifier, target: { kind: "module", id: idOf(specifier.slice(2)) } });
    }
  }
  return {
    modules: files.map((name) => ({ id: idOf(name), kind: "js", source: codeOf(name) })),
    resolutions: bundled,
  };
}

function entryNameOf(entryNames: ReadonlyMap<ModuleId, string>, id: ModuleId): string {
  const name = entryNames.get(id);
  if (name === undefined) throw prepareFailure(id, HOOK, "a script import's module is no entry of the bundle");
  return name;
}

/** The files bundling wrote, by name. */
async function build(
  entries: readonly ModuleId[],
  modules: ReadonlyMap<ModuleId, ArtifactModule>,
  resolutions: readonly ArtifactResolution[],
): Promise<Map<string, string>> {
  const graph = artifactGraph(entries, modules, resolutions);
  let result: Awaited<ReturnType<typeof Bun.build>>;
  try {
    result = await Bun.build({
      entrypoints: entries.map((_, index) => `${ENTRY_PREFIX}${index}`),
      target: "browser",
      format: "esm",
      splitting: true,
      // Whitespace only, which also drops the `// <path>` comments Bun writes per module.
      minify: { whitespace: true, syntax: false, identifiers: false },
      naming: { entry: "[name].[ext]", chunk: "chunk-[hash].[ext]" },
      // A preview is a development build: what Vite's dev server gives a package's browser code too.
      define: { "process.env.NODE_ENV": JSON.stringify("development") },
      plugins: [graph.plugin],
    });
  } catch (error) {
    const refusal = graph.failure();
    if (refusal !== null) throw refusal;
    throw prepareFailure(SOURCE, HOOK, `bundling failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const refusal = graph.failure();
  if (refusal !== null) throw refusal;
  if (!result.success) throw prepareFailure(SOURCE, HOOK, `bundling failed: ${result.logs.map(String).join("\n")}`);
  const files = new Map<string, string>();
  for (const output of result.outputs) {
    if (output.kind !== "entry-point" && output.kind !== "chunk") {
      throw prepareFailure(SOURCE, HOOK, `bundling wrote ${output.path}, a ${output.kind} no browser module can be`);
    }
    files.set(output.path.replace(/^\.\//, ""), await output.text());
  }
  return files;
}

interface ArtifactGraphPlugin {
  plugin: BunPlugin;
  /** Why the plugin refused, kept here: Bun reports a plugin's throw as its own build error. */
  failure(): PrepareError | null;
}

/** Every import answered from the browser graph, every source from the artifact. */
function artifactGraph(
  entries: readonly ModuleId[],
  modules: ReadonlyMap<ModuleId, ArtifactModule>,
  resolutions: readonly ArtifactResolution[],
): ArtifactGraphPlugin {
  let failure: PrepareError | null = null;
  const refuse = (source: string, reason: string): never => {
    const refusal = prepareFailure(source, HOOK, reason);
    failure ??= refusal;
    throw refusal;
  };
  const byImporter = new Map<ModuleId, Map<string, ModuleId>>();
  for (const resolution of resolutions) {
    let bySpecifier = byImporter.get(resolution.importer);
    if (bySpecifier === undefined) {
      bySpecifier = new Map();
      byImporter.set(resolution.importer, bySpecifier);
    }
    bySpecifier.set(resolution.specifier, targetId(resolution));
  }
  const plugin: BunPlugin = {
    name: "pletivo-browser-graph",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.importer === "" && args.path.startsWith(ENTRY_PREFIX)) {
          const entry = entries[Number(args.path.slice(ENTRY_PREFIX.length))];
          if (entry === undefined) return refuse(SOURCE, `no entry ${args.path}`);
          return { path: entry, namespace: NAMESPACE };
        }
        const target = byImporter.get(args.importer)?.get(args.path);
        if (target === undefined) return refuse(args.importer, `${JSON.stringify(args.path)} is not in the browser graph`);
        return { path: target, namespace: NAMESPACE };
      });
      build.onLoad({ filter: /.*/, namespace: NAMESPACE }, (args) => {
        const module = modules.get(args.path);
        if (module === undefined) return refuse(args.path, "the browser graph names a module the artifact does not carry");
        if (module.kind === "css") return { contents: browserStylesheetModule(module.id, module.source), loader: "js" };
        const loader = loaderOf(module);
        if (loader === null) return refuse(module.id, `a .${module.kind} module cannot run in the browser`);
        return { contents: module.source, loader };
      });
    },
  };
  return { plugin, failure: () => failure };
}

function loaderOf(module: ArtifactModule): Loader | null {
  if (module.kind === "js" || module.kind === "ts" || module.kind === "json") return module.kind;
  return null;
}

function targetId(resolution: ArtifactResolution): ModuleId {
  if (resolution.target.kind !== "module") {
    throw prepareFailure(resolution.importer, HOOK, `${JSON.stringify(resolution.specifier)} resolves to an external`);
  }
  return resolution.target.id;
}
