/**
 * The project's framework components and renderers, compiled and bundled for the Workers
 * host's server render. The isolate can run neither the frameworks' compilers nor their CommonJS
 * packages, so prepare compiles every file a renderer's compiler claims with the same compilers
 * `pletivo build` uses and bundles them with every renderer's server entrypoint into one graph:
 * a component and its renderer then share one framework runtime, as React's hooks need.
 *
 * A component's stylesheet imports stay imports of project files (`ISLAND_STYLESHEET_PREFIX`),
 * so CSS stays live; editing a component needs a new prepare.
 */

import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { builtinModules } from "node:module";
import path from "node:path";
import {
  ARTIFACT_BUILTIN_EXTERNALS,
  ISLAND_STYLESHEET_PREFIX,
  ISLANDS_BUNDLE_MODULE_PREFIX,
  digestArtifactInput,
  type ArtifactInput,
  type ArtifactIslands,
  type ArtifactModule,
  type ArtifactResolution,
  type ModuleId,
} from "@pletivo/core/artifact";
import type { AstroRendererEntry } from "@pletivo/core/astro-host/renderers";
import { compareStrings } from "@pletivo/core/compare-strings";
import {
  offeredSuffix,
  type FrameworkCompileInput,
  type FrameworkCompileOutput,
  type FrameworkCompiler,
} from "@pletivo/core/framework-compile/types";
import type { BunPlugin, Loader } from "bun";
import { readIslandScripts } from "../astro-renderers";
import { resolveViteId, tryLoadViteId } from "../astro-host/vite-plugins";
import { frameworkCompilePlugin, loadFrameworkCompilers } from "../framework-compile";
import { prepareFailure, PrepareError } from "./error";
import { isInsideRoot, normalizePath } from "./paths";
import { ImportScanError, specifiersOf } from "./scan";
import type { ProjectImportSource } from "./vendor";

const SOURCE = "astro.config";
const HOOK = "islands";
const ENTRY_PREFIX = "pletivo-islands-entry-";
const ENTRY_NAMESPACE = "pletivo-islands-entry";
const STYLESHEET_NAMESPACE = "pletivo-islands-stylesheet";
const BUILTIN_NAMESPACE = "pletivo-islands-builtin";
const NODE_BUILTINS = new Set(builtinModules.map((specifier) => specifier.replace(/^node:/, "")));
/** Never on disk. In the project root, so a virtual module's own imports resolve from its `node_modules`. */
const VIRTUAL_DIR = "__pletivo_islands_virtual__";
/** The export conditions the vendor graph resolves with, for workerd. */
const WORKER_CONDITIONS = ["workerd", "worker"];
const BUNDLE_SCANNER = new Bun.Transpiler({ loader: "js" });

export interface PreparedIslands {
  islands: ArtifactIslands;
  modules: ArtifactModule[];
  resolutions: ArtifactResolution[];
  /** The files a renderer's compiler claimed, absolute: no other graph walks them. */
  componentFiles: ReadonlySet<string>;
  /** Every project file the bundle compiled in, components included, absolute. */
  bundledFiles: ReadonlySet<string>;
  /** `bundledFiles`, as read: editing one needs a new prepare. */
  inputs: ArtifactInput[];
}

interface Entry {
  name: string;
  source: string;
  /** For a build log line. */
  label: string;
}

/** `null` for a project without renderers. */
export async function prepareIslands(
  projectRoot: string,
  renderers: readonly AstroRendererEntry[],
  sources: readonly ProjectImportSource[],
): Promise<PreparedIslands | null> {
  if (renderers.length === 0) return null;
  let compilers: FrameworkCompiler[];
  try {
    compilers = await loadFrameworkCompilers(projectRoot, renderers);
  } catch (error) {
    throw prepareFailure(SOURCE, HOOK, `the renderers' compilers cannot be loaded: ${message(error)}`);
  }
  const compiled = new Map<string, { source: string; output: FrameworkCompileOutput }>();
  const compile = async (compiler: FrameworkCompiler, input: FrameworkCompileInput): Promise<FrameworkCompileOutput | null> => {
    const known = compiled.get(input.filename);
    if (known !== undefined && known.source === input.source) return known.output;
    const output = await compiler.compile(input);
    if (output !== null) compiled.set(input.filename, { source: input.source, output });
    return output;
  };

  const components: { file: string; source: string }[] = [];
  const suffixes = compilers.flatMap((compiler) => compiler.extensions);
  for (const source of sources) {
    const suffix = offeredSuffix(source.file, suffixes);
    if (suffix === null) continue;
    for (const compiler of compilers) {
      if (!compiler.extensions.includes(suffix)) continue;
      let output: FrameworkCompileOutput | null;
      try {
        output = await compile(compiler, { source: source.source, filename: source.file, target: "server" });
      } catch (error) {
        throw prepareFailure(displayPath(projectRoot, source.file), HOOK, `${compiler.framework} cannot compile it: ${message(error)}`);
      }
      if (output === null) continue;
      components.push({ file: source.file, source: source.source });
      break;
    }
  }

  const stylesheets = new Map<string, string>();
  const bundling = compilers.map((compiler): FrameworkCompiler => ({
    framework: compiler.framework,
    extensions: compiler.extensions,
    async compile(input) {
      const output = await compile(compiler, input);
      if (output === null || output.css === null) return output;
      // Beside the component, as the Bun host places it, so its relative `url()` and `@import` resolve alike.
      const file = projectStylesheet(projectRoot, `${input.filename}.pletivo-style.css`, input.filename);
      stylesheets.set(file, output.css);
      return { code: `import ${JSON.stringify(ISLAND_STYLESHEET_PREFIX + file)};\n${output.code}`, loader: output.loader, css: null };
    },
  }));

  const entries: Entry[] = [];
  const rendererEntries: { renderer: AstroRendererEntry; name: string }[] = [];
  for (const renderer of renderers) {
    const file = resolveServerEntrypoint(renderer, projectRoot);
    const name = `${ENTRY_PREFIX}${entries.length}`;
    entries.push({ name, source: `export { default } from ${JSON.stringify(file)};\n`, label: `renderer ${renderer.name}` });
    rendererEntries.push({ renderer, name });
  }
  const componentEntries: { file: string; name: string }[] = [];
  for (const component of components) {
    const name = `${ENTRY_PREFIX}${entries.length}`;
    entries.push({ name, source: await componentEntrySource(component.file, compiled), label: displayPath(projectRoot, component.file) });
    componentEntries.push({ file: component.file, name });
  }

  const { files, loaded } = await build(projectRoot, entries, bundling);
  const bundledFiles = new Set([...loaded].filter((file) => isProjectFile(projectRoot, file)));
  const reached = bundleImports(files);
  const names = [...reached.keys()].sort(compareStrings);
  const digest = new Bun.CryptoHasher("sha256");
  for (const name of names) digest.update(`${name}\0${files.get(name)}\0`);
  const directory = `${ISLANDS_BUNDLE_MODULE_PREFIX}${digest.digest("hex").slice(0, 32)}`;
  const idOf = (name: string): ModuleId => `${directory}/${name}`;
  const fileOf = (entry: string): string => `${entry}.js`;

  const resolutions: ArtifactResolution[] = [];
  for (const [name, specifiers] of reached) {
    for (const specifier of specifiers) {
      if (specifier.startsWith(ISLAND_STYLESHEET_PREFIX)) continue;
      if (ARTIFACT_BUILTIN_EXTERNALS.has(specifier)) {
        resolutions.push({ importer: idOf(name), specifier, target: { kind: "external", specifier } });
        continue;
      }
      resolutions.push({ importer: idOf(name), specifier, target: { kind: "module", id: idOf(specifier.slice(2)) } });
    }
  }
  return {
    islands: {
      projectRoot: normalizePath(projectRoot),
      renderers: rendererEntries.map(({ renderer, name }) => ({
        name: renderer.name,
        clientEntrypoint: renderer.clientEntrypoint,
        server: idOf(fileOf(name)),
      })),
      scripts: await islandScripts(projectRoot),
      components: componentEntries.map(({ file, name }) => ({
        file: normalizePath(path.relative(projectRoot, file)),
        module: idOf(fileOf(name)),
      })),
      stylesheets: [...stylesheets].map(([file, source]) => ({ file, source })),
    },
    modules: names.map((name) => ({ id: idOf(name), kind: "js", source: files.get(name) ?? "" })),
    resolutions,
    componentFiles: new Set(components.map((component) => component.file)),
    bundledFiles,
    inputs: await bundleInputs(projectRoot, bundledFiles),
  };
}

async function islandScripts(projectRoot: string): Promise<ArtifactIslands["scripts"]> {
  try {
    const scripts = await readIslandScripts(projectRoot);
    return { island: scripts.island, directives: { ...scripts.directives } };
  } catch (error) {
    throw prepareFailure(SOURCE, HOOK, message(error));
  }
}

function resolveServerEntrypoint(renderer: AstroRendererEntry, projectRoot: string): string {
  if (path.isAbsolute(renderer.serverEntrypoint)) return renderer.serverEntrypoint;
  try {
    return Bun.resolveSync(renderer.serverEntrypoint, projectRoot);
  } catch (error) {
    throw prepareFailure(
      SOURCE,
      HOOK,
      `renderer "${renderer.name}": its serverEntrypoint ${renderer.serverEntrypoint} cannot be resolved from the project root: ${message(error)}`,
    );
  }
}

/** Re-exports the component as written: its named exports, and its default when it has one. */
async function componentEntrySource(
  file: string,
  compiled: ReadonlyMap<string, { output: FrameworkCompileOutput }>,
): Promise<string> {
  const output = compiled.get(file)?.output;
  if (output === undefined) throw prepareFailure(file, HOOK, "the component was claimed and not compiled");
  const { exports } = new Bun.Transpiler({ loader: output.loader }).scan(output.code);
  const specifier = JSON.stringify(file);
  return `export * from ${specifier};\n${exports.includes("default") ? `export { default } from ${specifier};\n` : ""}`;
}

/** A stylesheet the bundle imports, as the project path the isolate reads it from. */
function projectStylesheet(projectRoot: string, file: string, importer: string): string {
  const relative = normalizePath(path.relative(projectRoot, file));
  if (!isInsideRoot(relative) || relative.split("/").includes("node_modules")) {
    throw prepareFailure(
      displayPath(projectRoot, importer),
      HOOK,
      `imports the stylesheet ${JSON.stringify(relative)}, which is not a project file; ` +
        "a framework component's stylesheets must be the project's own on the Workers host",
    );
  }
  return relative;
}

/** A file of the project's own, not a package's and not a virtual module's. */
function isProjectFile(projectRoot: string, file: string): boolean {
  const relative = normalizePath(path.relative(projectRoot, file));
  const segments = relative.split("/");
  return isInsideRoot(relative) && !segments.includes("node_modules") && segments[0] !== VIRTUAL_DIR;
}

async function bundleInputs(projectRoot: string, files: ReadonlySet<string>): Promise<ArtifactInput[]> {
  const inputs: ArtifactInput[] = [];
  for (const file of files) {
    inputs.push({ path: normalizePath(path.relative(projectRoot, file)), digest: await digestArtifactInput(await fs.readFile(file)) });
  }
  return inputs;
}

/**
 * The bundled project files no live module imports: those stay out of the vendor graph, which would
 * otherwise carry their framework imports. One a live module imports too is compiled twice, once
 * into the bundle and once live, and is two module instances on the Workers host.
 */
export function bundleOnlyFiles(islands: PreparedIslands, sources: readonly ProjectImportSource[]): Set<string> {
  const bundleOnly = new Set([...islands.bundledFiles].filter((file) => !islands.componentFiles.has(file)));
  const byFile = new Map(sources.map((source) => [source.file, source]));
  const queue = sources.filter((source) => !islands.bundledFiles.has(source.file));
  for (let live = queue.shift(); live !== undefined; live = queue.shift()) {
    let specifiers: string[];
    try {
      specifiers = specifiersOf(live.file, live.source);
    } catch (error) {
      // The vendor graph scans the same file and refuses it by name.
      if (error instanceof ImportScanError) continue;
      throw error;
    }
    for (const specifier of specifiers) {
      const target = resolvedFile(specifier, path.dirname(live.file));
      if (target === null || !bundleOnly.delete(target)) continue;
      const source = byFile.get(target);
      if (source !== undefined) queue.push(source);
    }
  }
  return bundleOnly;
}

function resolvedFile(specifier: string, fromDir: string): string | null {
  try {
    return Bun.resolveSync(specifier, fromDir);
  } catch {
    return null;
  }
}

/** The files bundling wrote, by name, and the files it read. */
async function build(
  projectRoot: string,
  entries: readonly Entry[],
  compilers: readonly FrameworkCompiler[],
): Promise<{ files: Map<string, string>; loaded: Set<string> }> {
  const loaded = new Set<string>();
  let failure: PrepareError | null = null;
  const refuse = (source: string, reason: string): never => {
    const refusal = prepareFailure(source, HOOK, reason);
    failure ??= refusal;
    throw refusal;
  };
  let result: Awaited<ReturnType<typeof Bun.build>>;
  try {
    result = await Bun.build({
      entrypoints: entries.map((entry) => entry.name),
      root: projectRoot,
      target: "browser",
      conditions: WORKER_CONDITIONS,
      format: "esm",
      splitting: true,
      // Whitespace only, which also drops the `// <path>` comments Bun writes per module.
      minify: { whitespace: true, syntax: false, identifiers: false },
      naming: { entry: "[name].[ext]", chunk: "chunk-[hash].[ext]" },
      // `pletivo build` renders with production builds of the frameworks.
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
      throw: false,
      plugins: [
        loadTracker(loaded),
        entryPlugin(entries),
        builtinPlugin(projectRoot, refuse),
        stylesheetPlugin(projectRoot, refuse),
        virtualModulePlugin(projectRoot, refuse),
        frameworkCompilePlugin({
          compilers,
          target: "server",
          loadedByRuntime: false,
          onCss(filename) {
            refuse(filename, "a compiled module's CSS must be imported by the module");
          },
        }),
      ],
    });
  } catch (error) {
    if (failure !== null) throw failure;
    throw prepareFailure(SOURCE, HOOK, `bundling failed: ${message(error)}`);
  }
  if (failure !== null) throw failure;
  if (!result.success) {
    const labels = new Map(entries.map((entry) => [entry.name, entry.label]));
    throw prepareFailure(SOURCE, HOOK, `bundling failed:\n${formatLogs(result.logs, labels)}`);
  }
  const files = new Map<string, string>();
  for (const output of result.outputs) {
    const name = output.path.replace(/^\.\//, "");
    if (output.kind !== "entry-point" && output.kind !== "chunk") {
      throw prepareFailure(SOURCE, HOOK, `bundling wrote ${name}, a ${output.kind}: a framework component imports a file the Workers host cannot serve`);
    }
    files.set(name, await output.text());
  }
  return { files, loaded };
}

/** Records every file bundling reads, and leaves loading it to the plugins after it. */
function loadTracker(loaded: Set<string>): BunPlugin {
  return {
    name: "pletivo-islands-load-tracker",
    setup(build) {
      build.onLoad({ filter: /.*/, namespace: "file" }, (args) => {
        loaded.add(args.path);
        return undefined;
      });
    },
  };
}

/** Every file's imports, checked to end inside the bundle, at a project stylesheet or at a host built-in. */
function bundleImports(files: ReadonlyMap<string, string>): Map<string, string[]> {
  const imports = new Map<string, string[]>();
  for (const [name, code] of files) {
    const specifiers = [...new Set(BUNDLE_SCANNER.scanImports(code).map((entry) => entry.path))];
    for (const specifier of specifiers) {
      if (specifier.startsWith(ISLAND_STYLESHEET_PREFIX) || ARTIFACT_BUILTIN_EXTERNALS.has(specifier)) continue;
      if (!specifier.startsWith("./") || !files.has(specifier.slice(2))) {
        throw prepareFailure(SOURCE, HOOK, `${name} imports ${JSON.stringify(specifier)}, which is not a file of the bundle`);
      }
    }
    imports.set(name, specifiers);
  }
  return imports;
}

function entryPlugin(entries: readonly Entry[]): BunPlugin {
  const sources = new Map(entries.map((entry) => [entry.name, entry.source]));
  return {
    name: "pletivo-islands-entries",
    setup(build) {
      build.onResolve({ filter: new RegExp(`^${ENTRY_PREFIX}\\d+$`) }, (args) =>
        args.importer === "" ? { path: args.path, namespace: ENTRY_NAMESPACE } : undefined,
      );
      build.onLoad({ filter: /.*/, namespace: ENTRY_NAMESPACE }, (args) => {
        const contents = sources.get(args.path);
        return contents === undefined ? undefined : { contents, loader: "js" };
      });
    },
  };
}

/**
 * Every Node built-in the bundle reaches, before the browser target stubs or polyfills it: one the
 * render isolate provides stays an import of it, by its `node:` name; any other is refused.
 */
function builtinPlugin(projectRoot: string, refuse: (source: string, reason: string) => never): BunPlugin {
  return {
    name: "pletivo-islands-builtins",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        const name = args.path.replace(/^node:/, "");
        if (!NODE_BUILTINS.has(name)) return undefined;
        const specifier = `node:${name}`;
        if (!ARTIFACT_BUILTIN_EXTERNALS.has(specifier)) {
          return refuse(
            displayPath(projectRoot, args.importer),
            `imports the Node built-in ${JSON.stringify(args.path)}, which the Workers host does not give framework ` +
              `components and renderers (only ${[...ARTIFACT_BUILTIN_EXTERNALS].join(", ")})`,
          );
        }
        if (args.path === specifier) return { path: specifier, external: true };
        // Bun prints an external import as written: a stub module spells the bare name the `node:` way.
        return { path: name, namespace: BUILTIN_NAMESPACE };
      });
      build.onLoad({ filter: /.*/, namespace: BUILTIN_NAMESPACE }, (args) => {
        const specifier = JSON.stringify(`node:${args.path}`);
        return { contents: `export * from ${specifier};\nexport { default } from ${specifier};\n`, loader: "js" };
      });
    },
  };
}

/**
 * A stylesheet stays out of the bundle as an import of the project file, which the isolate's
 * CSS graph reads; a compiled component's own CSS is already such an import.
 */
function stylesheetPlugin(projectRoot: string, refuse: (source: string, reason: string) => never): BunPlugin {
  return {
    name: "pletivo-islands-stylesheets",
    setup(build) {
      build.onResolve({ filter: new RegExp(`^${escapeRegExp(ISLAND_STYLESHEET_PREFIX)}`) }, (args) => ({
        path: args.path,
        external: true,
      }));
      build.onResolve({ filter: /\.css($|\?)/ }, (args) => {
        const importer = displayPath(projectRoot, args.importer);
        if (args.path.includes("?")) return refuse(importer, `imports ${JSON.stringify(args.path)}; a query on a stylesheet import is not supported on the Workers host`);
        if (!args.path.startsWith(".")) {
          return refuse(importer, `imports the package stylesheet ${JSON.stringify(args.path)}; a framework component's stylesheets must be the project's own on the Workers host`);
        }
        const file = path.resolve(path.dirname(args.importer), args.path);
        if (!existsSync(file)) return refuse(importer, `imports ${JSON.stringify(args.path)}, which does not exist`);
        // Bun prints an external import as written, so a stub module writes the prefixed one.
        // Its path must not equal that specifier, or Bun drops the import.
        return { path: projectStylesheet(projectRoot, file, args.importer), namespace: STYLESHEET_NAMESPACE };
      });
      build.onLoad({ filter: /.*/, namespace: STYLESHEET_NAMESPACE }, (args) => ({
        contents: `import ${JSON.stringify(ISLAND_STYLESHEET_PREFIX + args.path)};\n`,
        loader: "js",
      }));
    },
  };
}

/** An integration's Vite virtual module (`astro:react:opts`, `virtual:@astrojs/vue/app`), from its plugin. */
function virtualModulePlugin(projectRoot: string, refuse: (source: string, reason: string) => never): BunPlugin {
  const virtualDir = path.join(projectRoot, VIRTUAL_DIR);
  const loaded = new Map<string, { code: string; loader: Loader }>();
  return {
    name: "pletivo-islands-virtual-modules",
    setup(build) {
      build.onResolve({ filter: /^[^./]/ }, async (args) => {
        if (args.namespace === ENTRY_NAMESPACE || resolves(args.path, path.dirname(args.importer))) return undefined;
        const id = (await resolveViteId(args.path, args.importer)) ?? args.path;
        const { loaded: module, errors } = await tryLoadViteId(id);
        if (module === null) {
          if (errors.length === 0) return undefined;
          return refuse(displayPath(projectRoot, args.importer), `${JSON.stringify(args.path)}: ${errors.map(message).join("; ")}`);
        }
        const file = path.join(virtualDir, `${new Bun.CryptoHasher("sha256").update(id).digest("hex").slice(0, 16)}${extensionFor(module.loader)}`);
        loaded.set(file, module);
        return { path: file };
      });
      build.onLoad({ filter: new RegExp(`${escapeRegExp(virtualDir)}[\\\\/]`) }, (args) => {
        const module = loaded.get(args.path);
        return module === undefined ? undefined : { contents: module.code, loader: module.loader };
      });
    },
  };
}

function resolves(specifier: string, fromDir: string): boolean {
  try {
    Bun.resolveSync(specifier, fromDir);
    return true;
  } catch {
    return false;
  }
}

function extensionFor(loader: Loader): string {
  return loader === "css" || loader === "json" || loader === "jsx" || loader === "tsx" || loader === "ts" ? `.${loader}` : ".js";
}

function formatLogs(logs: readonly (BuildMessage | ResolveMessage)[], labels: ReadonlyMap<string, string>): string {
  return logs
    .map((log) => {
      const text = `${log.level}: ${log.message}`;
      if (!log.position) return text;
      const label = labels.get(log.position.file);
      return label === undefined ? `${log.position.file}:${log.position.line}:${log.position.column}: ${text}` : `${label}: ${text}`;
    })
    .join("\n");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function displayPath(root: string, file: string): string {
  return normalizePath(path.relative(root, file)) || normalizePath(file);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
