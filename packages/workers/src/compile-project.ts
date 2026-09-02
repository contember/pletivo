/**
 * Turns a virtual file map into the module bundle a Worker Loader executes.
 *
 * This is the whole of the "no filesystem" problem in one place. The Bun host lets
 * Bun's loader compile `.astro` on import and resolve the rest off disk; here every
 * module the isolate will ever see has to be named in the bundle, so each one is
 * compiled here: `.astro` through `@astrojs/compiler`, `.js` verbatim, and the import
 * specifiers rewritten to point at each other by bundle name.
 *
 * The Loader takes JavaScript, and the compiler copies `.astro` frontmatter into its
 * output verbatim — `export interface Props` included. So every module goes through
 * `stripTypes` on the way out, which also compiles the JSX in a `.tsx` page. That
 * runs *here*, in the host worker, which is the only place it can: workerd has no
 * `eval`, so nothing in the isolate could do it.
 *
 * ## The walk is demand-driven
 *
 * Given `entries`, only what those pages' import graphs reach is compiled. Measured on
 * a real project (`docs/todos/023 §4`): 109 modules compiled per request against a
 * median of 14 the requested page can reach.
 *
 * `resolve` is the single place that decides a module has to be in the bundle, so
 * naming it there is also how the walk discovers it — `nameOf` names and enqueues in
 * one step. Two things follow. The queue is drained with an index cursor rather than
 * `shift()`, because `resolve` runs *inside* `rewriteImports` and appends mid-walk.
 * And `bundleName` has to be a pure function of the path, because two pages reach a
 * shared module in orders of their own and a name that moved with discovery would
 * address one program twice.
 *
 * Without `entries` every module-shaped file is compiled, which is what a full
 * `pletivo build` wants and what every caller did before pruning existed.
 *
 * ## The per-file work is cacheable, the walk is not
 *
 * `compileFile` is everything that depends only on `(path, source, compiler)` — the
 * wasm transform, sucrase, the specifiers — and it is what `options.cache` holds.
 * `applyCompiled` is everything the file *set* decides, and it runs on a hit too,
 * which is why every side effect that lives inside `resolve` needs no storing. See
 * `compile-cache.ts`.
 */

import { is } from "@astrojs/compiler/utils";
import type { Node } from "@astrojs/compiler/types";
import type { ArtifactModuleKind, ModuleId, PreparedSite } from "@pletivo/core/artifact";
import { imageOutputPath } from "@pletivo/core/image";
import { compileAstro, parseAstro, type AstroCompiler } from "./astro-compiler.ts";
import {
  createArtifactResolver,
  executionNameForModuleId,
  ModuleIdentityCollisionError,
  normalizeProjectPath,
  projectModuleId,
} from "./artifact.ts";
import {
  ASSETS_DIR,
  ASSETS_SOURCES,
  ASSETS_SPECIFIER,
  IMAGE_RUNTIME_SPECIFIER,
} from "./astro-assets.ts";
import type { CompileCache, CompiledFile } from "./compile-cache.ts";
import type {
  ExecutableProgram,
  ResolvedStyleGraph,
} from "./compiled-program.ts";
import type { ProjectAssetInfo, ProjectAssetsView } from "./asset-port.ts";
import {
  ENV_CLIENT_SPECIFIER,
  ENV_CLIENT_MODULE_NAME,
  ENV_MODULES,
  ENV_SERVER_SPECIFIER,
  ENV_SERVER_MODULE_NAME,
  IMPORT_META_ENV_GLOBAL,
  type ProjectEnvUse,
} from "./env.ts";
import {
  collectImportedNames,
  collectSpecifiers,
  resolveSpecifier,
  rewriteImports,
} from "./rewrite-imports.ts";
import {
  CONTENT_MODULE_NAME,
  GENERATED_MODULES,
  IMAGE_MODULE_NAME,
  JSX_RUNTIME_MODULE_NAME,
  RUNTIME_MODULES,
  RUNTIME_MODULE_NAME,
} from "./generated/runtime-modules.ts";
import { md5Hex } from "./md5.ts";
import type {
  ResolvedModule,
  ResolvedModuleEdge,
  ResolvedModuleGraph,
  ResolvedTarget,
} from "./module-graph.ts";
import {
  isTailwindStylesheetSpecifier,
  TailwindNotConfiguredError,
  type TailwindStylesheets,
} from "./tailwind.ts";
import { JSX_IMPORT_SPECIFIER, stripTypes, TranspileError } from "./transpile.ts";

/** One `<style>` block from a `.astro` file, in the order it was written. */
export interface StyleBlock {
  /** `<style is:global>`. Gated on the component rendering, not on its scope class. */
  global: boolean;
  css: string;
}

export interface AstroStyles {
  /** The compiler's scope hash — the page carries it as `class="astro-{scope}"`. */
  scope: string;
  blocks: StyleBlock[];
}

export interface CompiledProject {
  /** Module name -> JavaScript, ready for `env.LOADER`. Includes `@pletivo/runtime`. */
  modules: Record<string, string>;
  /**
   * The file map this was compiled from: the caller's, plus whatever the artifact
   * contributed. Everything downstream that walks the graph — the CSS pipeline above
   * all — has to see the same map, or a `node_modules` component's edges lead nowhere.
   */
  sources: ReadonlyMap<string, string>;
  /** Project path -> its module name, for the files that produced one. */
  moduleNames: ReadonlyMap<string, string>;
  /**
   * The pages the bundle was built for: `options.entries`, or every module-shaped
   * file when the caller named none.
   *
   * `render.ts` builds the isolate's page table from this rather than from
   * `moduleNames`, which also holds the components and libraries those pages import —
   * modules the page loader is never called with.
   */
  entries: readonly string[];
  /** Project path -> the `<style>` blocks it declares. */
  styles: ReadonlyMap<string, AstroStyles>;
  /** Project path -> the project paths it imports, in execution order. */
  imports: ReadonlyMap<string, string[]>;
  /**
   * Project path -> the stylesheets it imports for their side effect.
   *
   * Kept apart from `imports` because they are not edges the isolate walks — a `.css`
   * module is empty in the bundle. They are what the project stylesheet is built from;
   * see `project-css.ts`.
   */
  cssImports: ReadonlyMap<string, string[]>;
  /**
   * Set when something in the project imports the content API, which is what puts
   * `pletivo-content.js` in the bundle. `null` otherwise, and then the bundle carries
   * none of it — the collection runtime is roughly a megabyte, and most projects have
   * no collections.
   */
  content: ProjectContent | null;
  /**
   * Whether the bundle carries the image runtime — because a page imports
   * `astro:assets`, or because a collection may resolve an `image()` schema through
   * the content binding. `render.ts` reads it to decide what its prelude installs.
   */
  images: boolean;
  /**
   * Whether any module read `import.meta.env`, and therefore whether the entry has to
   * install the global it was rewritten to. See `substituteImportMetaEnv`.
   */
  importMetaEnv: boolean;
  /**
   * Set when something in the project imports `astro:env`, with the names it takes
   * from each half. `null` otherwise, and then the bundle carries neither module.
   *
   * The values themselves are not here and never enter the module map: they ride in
   * the isolate's `env`, so rotating a secret does not recompile the project. See
   * `env.ts`.
   */
  env: ProjectEnvUse | null;
  /**
   * Files a `?url` import named, keyed by the URL path the HTML will spell.
   *
   * `import href from "./form.js?url"` resolves to a *string*, and the file it names
   * has to be served from that string or the `<script src={href}>` written with it
   * 404s. The Bun host content-hashes it under `_astro/` (`url-asset.ts`) and copies
   * it into `dist`; here it comes back with the render, the same way the project
   * stylesheet does, because a Worker has nowhere to put a file.
   */
  urlAssets: ReadonlyMap<string, string>;
  /** Frozen compiler/execution seam, derived from the same canonical resolution pass. */
  program: ExecutableProgram;
  /** Frozen CSS seam, retaining source-order edges by logical ModuleId. */
  styleGraph: ResolvedStyleGraph;
  /** The canonical graph behind both legacy maps and the frozen DTOs. */
  graph: ResolvedModuleGraph;
}

export interface ProjectContent {
  /**
   * Bundle name of the project's `content.config.*`, or `null` when it has none.
   * The isolate imports it to get the collection definitions — there is no other way
   * to obtain them, since `defineCollection` is a function call, not data.
   */
  configModule: string | null;
}

/**
 * The compiler bound to the `astro.wasm` the host worker's bundler embedded.
 *
 * Injectable because that binding only exists inside a real Worker — on Bun the
 * `.wasm` import resolves to a path, so tests hand in a compiler of their own.
 */
const bundled: AstroCompiler = { transform: compileAstro, parse: parseAstro };

/** Compiled to JavaScript by `@astrojs/compiler`. */
const COMPILED = ".astro";
/** Already JavaScript: carried into the bundle untouched. */
const VERBATIM = [".js", ".mjs"];
/** Resolvable as a style edge and represented by an empty Loader module. */
const EMPTY = [".css"];
/** Whether a project path becomes a module the isolate can run. */
export function isExecutableModule(file: string): boolean {
  const kind = projectModuleKind(file);
  return kind !== null && kind !== "css";
}

function projectModuleKind(file: string): ArtifactModuleKind | null {
  const extension = extensionOf(file);
  if (extension === COMPILED) return "astro";
  if (VERBATIM.includes(extension)) return "js";
  if (extension === ".ts" || extension === ".mts" || extension === ".cts") return "ts";
  if (extension === ".tsx") return "tsx";
  if (extension === ".jsx") return "jsx";
  if (extension === ".json") return "json";
  if (EMPTY.includes(extension)) return "css";
  return null;
}

/**
 * Specifiers that name pletivo's content API rather than a project file.
 *
 * The bare ones are what a project writes. `astro:content` and `astro/loaders` are
 * Astro's own and the Bun host already answers to both — `astro-plugin.ts` registers
 * them as Bun virtual modules, for `.tsx` as much as for `.astro` — and
 * `pletivo/content` is the package's own `exports` entry. A project written against
 * either renders on both hosts with nothing changed.
 */
type HostAlias =
  | { kind: "fixed"; executionName: string }
  | { kind: "content" }
  | { kind: "assets" }
  | { kind: "image" }
  | { kind: "env"; executionName: string };

/** Every supported public spelling converges on one generated singleton module. */
const HOST_ALIASES: ReadonlyMap<string, HostAlias> = new Map([
  [JSX_IMPORT_SPECIFIER, { kind: "fixed", executionName: JSX_RUNTIME_MODULE_NAME }],
  ["pletivo/jsx-dev-runtime", { kind: "fixed", executionName: JSX_RUNTIME_MODULE_NAME }],
  ["@pletivo/runtime/jsx-runtime", { kind: "fixed", executionName: JSX_RUNTIME_MODULE_NAME }],
  ["pletivo/astro-shim", { kind: "fixed", executionName: RUNTIME_MODULE_NAME }],
  ["@pletivo/runtime/astro-shim", { kind: "fixed", executionName: RUNTIME_MODULE_NAME }],
  ["astro:content", { kind: "content" }],
  ["astro/loaders", { kind: "content" }],
  ["pletivo/content", { kind: "content" }],
  [ASSETS_SPECIFIER, { kind: "assets" }],
  [IMAGE_RUNTIME_SPECIFIER, { kind: "image" }],
  [ENV_CLIENT_SPECIFIER, { kind: "env", executionName: ENV_CLIENT_MODULE_NAME }],
  [ENV_SERVER_SPECIFIER, { kind: "env", executionName: ENV_SERVER_MODULE_NAME }],
]);

const SUPPORTED_ARTIFACT_EXTERNALS = new Set(HOST_ALIASES.keys());
const UNSUPPORTED_PACKAGE_ROOTS = new Set(["pletivo", "@pletivo/runtime", "@pletivo/core"]);

/**
 * …and this is the shape *this repo* writes.
 *
 * Its fixtures predate the published package, so they reach into
 * `packages/pletivo/src/content/collection` by relative path — which
 * `resolveSpecifier` lands on the same project-root-relative key from every one of
 * them, however deep the importer sits. A path is not a package, so it can never be
 * in a virtual file map; matching it is what lets a fixture written for the Bun host
 * be previewed without being rewritten first.
 */
const PLETIVO_CONTENT_PATH = /(?:^|\/)pletivo\/src\/content\/(?:collection|index)(?:\.ts)?$/;

/** Whether a resolved specifier is the content API. */
export function isContentApi(resolved: string): boolean {
  return HOST_ALIASES.get(resolved)?.kind === "content" || PLETIVO_CONTENT_PATH.test(resolved);
}

/**
 * Where a project's collection definitions live *relative to `srcDir`*, in the order
 * the Bun host looks — `initCollections` takes the first that exists, so a project with
 * both gets the same one on either host.
 */
const CONTENT_CONFIG_CANDIDATES = [
  "content.config.ts",
  "content.config.mts",
  "content.config.mjs",
  "content.config.js",
  "content/config.ts",
  "content/config.mts",
  "content/config.mjs",
  "content/config.js",
];

/** Where the source tree sits in a project that did not say. */
const DEFAULT_SRC_DIR = "src";

/**
 * The project's content config, or `null`.
 *
 * Eight `files.has()` probes when the caller said where the source tree starts. Without
 * a `srcDir` there is no root to resolve against, so each candidate is matched as a
 * suffix over every key instead — which is what this did throughout, back when
 * `compileProject` was handed the file map alone.
 */
function findContentConfig(
  files: ReadonlyMap<string, string>,
  srcDir: string | undefined,
): string | null {
  if (srcDir !== undefined) {
    const prefix = srcDir === "" ? "" : `${srcDir}/`;
    for (const candidate of CONTENT_CONFIG_CANDIDATES) {
      if (files.has(prefix + candidate)) return prefix + candidate;
    }
    return null;
  }
  for (const candidate of CONTENT_CONFIG_CANDIDATES) {
    const suffix = `${DEFAULT_SRC_DIR}/${candidate}`;
    for (const file of files.keys()) {
      if (file === suffix || file.endsWith(`/${suffix}`)) return file;
    }
  }
  return null;
}

function extensionOf(file: string): string {
  const at = file.lastIndexOf(".");
  const slash = file.lastIndexOf("/");
  return at === -1 || at < slash ? "" : file.slice(at).toLowerCase();
}

/**
 * Extensions tried when a specifier names no file map key on its own, in the order
 * Bun's resolver tries them — so a project that runs on the Bun host resolves the same
 * way here.
 */
const IMPLIED_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".astro", ".mts", ".cts"];

/**
 * What a resolved specifier actually names in the file map.
 *
 * `import Layout from "../components/Layout"` is ordinary in a TypeScript project and
 * names no key; so is `import { x } from "./util.js"` when the file on disk is
 * `util.ts`, which is what `moduleResolution: nodenext` asks authors to write. Both
 * resolve off the filesystem on the Bun host, and both used to reach the isolate as an
 * unresolved specifier — `docs/todos/016 §7` listed them as the two smaller edges.
 *
 * Every caller that walks the graph goes through here, so the module rewriting, the
 * import edges and the CSS cascade order all agree on which file was meant.
 */
/**
 * Vite's import suffixes, of which pletivo answers two.
 *
 * `?raw` and `?inline` both mean the file's text here, because that is what the Bun
 * host's loader makes of them (`astro-plugin.ts:571`) and the two hosts have to agree.
 * (Vite's `?inline` is a data: URI — a divergence pletivo already carries.) `?url`
 * means the URL of the emitted file, which is a different thing entirely: a string
 * the HTML spells, and a file somebody then has to serve.
 */
export function importQuery(resolved: string): { file: string; kind: "text" | "url" } | null {
  const mark = resolved.indexOf("?");
  if (mark === -1) return null;
  const query = resolved.slice(mark + 1);
  const file = resolved.slice(0, mark);
  if (/(^|&)(raw|inline)(&|=|$)/.test(query)) return { file, kind: "text" };
  if (/(^|&)url(&|=|$)/.test(query)) return { file, kind: "url" };
  return null;
}

/**
 * The URL a `?url` import resolves to, and the file registered under it.
 *
 * `_astro/<base>.<md5-8><ext>`, which is what the Bun host emits (`url-asset.ts`), so
 * a project's markup spells the same href on either host. Content-hashed, so a host
 * can cache it forever and two renders of the same project agree on the name.
 */
function urlAssetHref(
  file: string,
  source: string,
  urlAssets: Map<string, string>,
): string {
  const slash = file.lastIndexOf("/");
  const name = file.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const base = dot === -1 ? name : name.slice(0, dot);
  const extension = dot === -1 ? "" : name.slice(dot);
  const href = `/_astro/${base}.${md5Hex(source).slice(0, 8)}${extension}`;
  urlAssets.set(href, source);
  return href;
}

export function resolveInFiles(
  resolved: string,
  files: ReadonlyMap<string, string>,
): string | null {
  if (files.has(resolved)) return resolved;
  const extension = extensionOf(resolved);
  // `./util.js` naming a `util.ts`: TypeScript's own convention, and it has to be
  // tried before the implied-extension pass or `util.js.ts` would be looked for first.
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") {
    const stem = resolved.slice(0, -extension.length);
    for (const candidate of [".ts", ".tsx", ".mts", ".cts"]) {
      if (files.has(stem + candidate)) return stem + candidate;
    }
  }
  if (extension === "") {
    for (const candidate of IMPLIED_EXTENSIONS) {
      if (files.has(resolved + candidate)) return resolved + candidate;
    }
    for (const candidate of IMPLIED_EXTENSIONS) {
      if (files.has(`${resolved}/index${candidate}`)) return `${resolved}/index${candidate}`;
    }
  }
  return null;
}

/**
 * The name a project file takes in the bundle.
 *
 * Every module sits at the bundle root, so a relative specifier is always
 * `./<name>` no matter how deep the importer was — the isolate never has to
 * resolve a path. A pure function of the path, deliberately: a compile pruned to
 * one page's graph reaches files in an order of its own, and a name that moved
 * with discovery order would give one program two bundles.
 */
/**
 * `bundleName`, with the collision it cannot rule out turned into an error.
 *
 * The hash makes one unlikely, not impossible, and an unnoticed collision would silently
 * overwrite a module in the bundle — the failure would surface as an unresolvable import
 * somewhere else entirely.
 */
function claimBundleName(id: ModuleId, taken: Map<string, ModuleId>): string {
  const name = executionNameForModuleId(id);
  const other = taken.get(name);
  if (other !== undefined && other !== id) {
    throw new Error(
      `[pletivo-workers] ${JSON.stringify(id)} and ${JSON.stringify(other)} both compile to ` +
        `the bundle name ${JSON.stringify(name)}`,
    );
  }
  taken.set(name, id);
  return name;
}

/**
 * The compiler emits one `import '<file>?astro&type=style&index=N&lang.css'` per
 * `<style>` block, and nothing in the bundle answers to that specifier. The Bun
 * host strips the same imports for the same reason — the CSS is already in
 * `result.css`.
 */
function stripStyleImports(code: string): string {
  return code.replace(/import\s+['"][^'"]*\?astro&type=style[^'"]*['"];?/g, "");
}

/** Keep the compiler filename for scope hashing, but expose logical identity at render time. */
function replaceAstroTrackingId(code: string, compilePath: string, moduleId: ModuleId): string {
  const field = `, ${compilerString(compilePath)}, undefined);`;
  const call = code.lastIndexOf(" = $$createComponent(");
  const at = call === -1 ? -1 : code.indexOf(field, call);
  if (call === -1 || at === -1) {
    throw new UnsupportedFileError(
      compilePath,
      "the Astro compiler did not emit its createComponent module-id field",
    );
  }
  return code.slice(0, at) + `, ${compilerString(moduleId)}, undefined);` + code.slice(at + field.length);
}

function compilerString(value: string): string {
  return `'${value
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")}'`;
}

/**
 * Pair each `result.css[]` entry with the `<style>` block that produced it, so the
 * `is:global` ones can be told apart.
 *
 * Reading `is:global` off the source rather than looking for a `:where(.astro-…)`
 * marker in the compiled CSS is the same choice `classifyCompilerCss` makes on the
 * Bun host, for the same reason: the compiler cannot scope `body`, `html` or
 * `:root`, so a scoped block holding only those rules looks global but is not.
 */
export async function classifyStyles(
  css: string[],
  source: string,
  compiler: AstroCompiler = bundled,
): Promise<StyleBlock[]> {
  const { ast } = await compiler.parse(source);
  const blocks: StyleBlock[] = [];
  let index = 0;

  const visit = (node: Node): void => {
    if (is.element(node) && node.name === "style") {
      // The compiler drops blocks that compile to nothing, so skip them here too or
      // the 1:1 pairing with `css[index]` slips by one.
      const text = node.children.filter(is.text).map((child) => child.value).join("");
      if (text.replace(/\/\*[\s\S]*?\*\//g, "").trim().length === 0) return;
      if (index >= css.length) {
        throw new Error(
          "[pletivo-workers] more non-empty <style> blocks than css entries " +
            `(${css.length}); the @astrojs/compiler output contract may have changed`,
        );
      }
      blocks.push({
        global: node.attributes.some((attribute) => attribute.name === "is:global"),
        css: css[index++],
      });
      return;
    }
    if (is.parent(node)) for (const child of node.children) visit(child);
  };
  visit(ast);

  if (index !== css.length) {
    throw new Error(
      `[pletivo-workers] ${index} non-empty <style> block(s) but ${css.length} css entries; ` +
        "the @astrojs/compiler output contract may have changed",
    );
  }
  return blocks;
}

/** A project file the isolate cannot be given, and why. */
export class UnsupportedFileError extends Error {
  constructor(readonly file: string, reason: string) {
    super(`[pletivo-workers] cannot compile ${JSON.stringify(file)}: ${reason}`);
    this.name = "UnsupportedFileError";
  }
}

export interface CompileProjectOptions {
  /** The project: path (no leading slash, `/` separators) -> source text. */
  files: ReadonlyMap<string, string>;
  /**
   * The pages the bundle has to serve. Only what their import graphs reach is
   * compiled — see the walk in the header.
   *
   * Absent, every module-shaped file in the map is compiled. That is what a caller
   * wanting the whole project gets, and it is the behaviour every caller had before
   * pruning existed.
   */
  entries?: readonly string[];
  /** Overrides the compiler bound to the bundled `astro.wasm` — see `bundled` above. */
  compiler?: AstroCompiler;
  /**
   * Where the source tree starts in `files`, e.g. `src`.
   *
   * Only the content config needs it, and only to be probed for rather than scanned
   * after: nothing in a project imports it, so a pruned walk has to seed it by path.
   */
  srcDir?: string;
  /**
   * What `pletivo prepare` froze: it answers the bare specifiers the file map cannot,
   * and contributes the `node_modules` sources those specifiers land on. Without one,
   * a bare specifier is left alone and the Loader reports it — which is where every
   * project with an npm dependency stood before the artifact existed.
   */
  artifact?: PreparedSite | null;
  /** Tailwind's host-embedded CSS sources, used only for CSS imports of its public stylesheets. */
  tailwind?: TailwindStylesheets;
  /**
   * The project's binary files. An image *something imports* becomes a metadata
   * module, so `import hero from "./hero.png"` resolves to the same `{src, width,
   * height, format}` the Bun host's loader produces — built here, in the host worker,
   * because an ESM default export is a value and the isolate cannot go and fetch one.
   *
   * Only what is imported, not everything in the map: a photo site can hold thousands
   * of images and a page reaches a handful. The rest are named by the collections that
   * carry them, over the binding, one entry at a time.
   */
  assets?: ProjectAssetsView;
  /**
   * Compiled files kept between calls, keyed by path and checked by `source ===`.
   * Absent, every file is compiled. See `compile-cache.ts` for what an entry carries
   * and why the rest is reproduced on a hit rather than stored.
   */
  cache?: CompileCache;
}

/** One file the walk has claimed a name for and has still to compile. */
interface Pending {
  module: SourceModule;
}

interface SourceModule {
  id: ModuleId;
  legacyKey: string;
  kind: ArtifactModuleKind;
  source: string;
  compilePath: string;
  executionName: string;
  origin: "project" | "artifact" | "generated";
}

interface ResolutionUse {
  edge: ResolvedModuleEdge;
  rewritten: string;
  targetLegacyKey: string | null;
}

function sameDescriptor(
  left: Omit<SourceModule, "executionName">,
  right: SourceModule,
): boolean {
  return (
    left.kind === right.kind &&
    left.source === right.source &&
    left.compilePath === right.compilePath &&
    left.origin === right.origin
  );
}

function moduleResolution(
  importer: SourceModule,
  specifier: string,
  target: SourceModule,
): ResolutionUse {
  return {
    edge: {
      importer: importer.id,
      specifier,
      target: { kind: "module", id: target.id },
      kind: target.kind === "css" ? "style" : "execution",
    },
    rewritten: `./${target.executionName}`,
    targetLegacyKey: target.legacyKey,
  };
}

function externalResolution(
  importer: SourceModule,
  specifier: string,
  external: string,
  executionName: string,
): ResolutionUse {
  return {
    edge: {
      importer: importer.id,
      specifier,
      target: { kind: "external", specifier: external },
      kind: "execution",
    },
    rewritten: `./${executionName}`,
    targetLegacyKey: null,
  };
}

function unresolvedImport(
  importer: SourceModule,
  specifier: string,
  reason: string,
): UnsupportedFileError {
  return new UnsupportedFileError(
    importer.compilePath,
    `import ${JSON.stringify(specifier)} from ${JSON.stringify(importer.id)} is unresolved: ${reason}`,
  );
}

function normalizeProjectFiles(files: ReadonlyMap<string, string>): Map<string, string> {
  const normalized = new Map<string, string>();
  const owners = new Map<string, string>();
  for (const [inputPath, source] of files) {
    const path = normalizeProjectPath(inputPath);
    if (path.length === 0) throw new UnsupportedFileError(inputPath, "the normalized path is empty");
    const owner = owners.get(path);
    if (owner !== undefined && owner !== inputPath) {
      throw new ModuleIdentityCollisionError(
        projectModuleId(path),
        `${JSON.stringify(inputPath)} and ${JSON.stringify(owner)} normalize to the same project module`,
      );
    }
    owners.set(path, inputPath);
    normalized.set(path, source);
  }
  return normalized;
}

function addAssetSources(projectFiles: Map<string, string>, files: Map<string, string>): void {
  for (const [file, source] of Object.entries(ASSETS_SOURCES)) {
    if (!projectFiles.has(file)) projectFiles.set(file, source);
    if (!files.has(file)) files.set(file, source);
  }
}

function moduleTargetId(target: ResolvedTarget): ModuleId {
  if (target.kind !== "module") {
    throw new Error("[pletivo-workers] an external target cannot become a module edge");
  }
  return target.id;
}

function sourceLegacyKey(id: ModuleId, claimed: ReadonlyMap<ModuleId, SourceModule>): string {
  return claimed.get(id)?.legacyKey ?? id;
}

/**
 * Compile what `entries` reaches, or every module-shaped file when it names none.
 *
 * Files the bundle has no use for (`.md`, images, `astro.config.mjs` outside the
 * graph) are simply not modules and are skipped; a file that *is* reachable but
 * needs a transpiler throws, because silently omitting it turns into an
 * unresolved import inside the isolate, which is much harder to read.
 *
 * A file nothing reaches is now never read, so a syntax error in it never surfaces.
 * That is the point for an on-demand render and it is a real behaviour change; see
 * `docs/todos/023 §10`.
 */
export async function compileProject(options: CompileProjectOptions): Promise<CompiledProject> {
  const { compiler = bundled, assets, cache } = options;
  const artifact = createArtifactResolver(options.artifact, SUPPORTED_ARTIFACT_EXTERNALS);
  const projectFiles = normalizeProjectFiles(options.files);
  const files = new Map<string, string>(projectFiles);
  for (const module of artifact.modules()) files.set(module.id, module.source);
  /** URL path -> the file's text, for every `?url` import the project made. */
  const urlAssets = new Map<string, string>();
  const modules: Record<string, string> = { ...RUNTIME_MODULES };
  const moduleNames = new Map<string, string>();
  const styles = new Map<string, AstroStyles>();
  const imports = new Map<string, string[]>();
  const cssImports = new Map<string, string[]>();
  const takenNames = new Map<string, ModuleId>();
  const claimed = new Map<ModuleId, SourceModule>();
  const graphModules: ResolvedModule[] = [];
  const graphEdges: ResolvedModuleEdge[] = [];
  const assetInfos = new Map<string, Promise<ProjectAssetInfo | null>>();
  /** Named and not yet compiled. Appended to *while* it is walked; see the header. */
  const queue: Pending[] = [];
  /** Names taken from `astro:env/client` and `astro:env/server`, across the whole walk. */
  const envNames = new Map<string, Set<string>>(
    [...ENV_MODULES.keys()].map((specifier) => [specifier, new Set<string>()]),
  );

  /**
   * The bundle name of a project file, claimed on first sight — which is also how the
   * file joins the walk. `null` for anything the bundle cannot hold as a module.
   *
   * Naming lazily is what makes a forward reference work: `rewriteImports` runs while
   * compiling A and has to emit `./<name-of-B>` before B has been read, and the name
   * is a pure function of B's path, so it can be claimed without reading it.
   */
  const claim = (module: Omit<SourceModule, "executionName">): SourceModule => {
    const known = claimed.get(module.id);
    if (known !== undefined) {
      if (!sameDescriptor(module, known)) {
        throw new ModuleIdentityCollisionError(module.id, "the claimed module descriptors differ");
      }
      moduleNames.set(module.legacyKey, known.executionName);
      return known;
    }
    const executionName = claimBundleName(module.id, takenNames);
    const sourceModule: SourceModule = { ...module, executionName };
    claimed.set(module.id, sourceModule);
    moduleNames.set(module.legacyKey, executionName);
    graphModules.push({
      identity: {
        id: module.id,
        compilePath: module.compilePath,
        executionName,
      },
      kind: module.kind,
      source: module.source,
    });
    queue.push({ module: sourceModule });
    return sourceModule;
  };

  const projectModule = (file: string): SourceModule | null => {
    const source = projectFiles.get(file);
    const kind = projectModuleKind(file);
    if (source === undefined || kind === null) return null;
    return claim({
      id: projectModuleId(file),
      legacyKey: file,
      kind,
      source,
      compilePath: file,
      origin: "project",
    });
  };

  const artifactModule = (id: ModuleId): SourceModule => {
    const module = artifact.module(id);
    if (module === null) {
      throw new UnsupportedFileError(id, "the validated artifact target is missing");
    }
    return claim({
      id: module.id,
      legacyKey: module.id,
      kind: module.kind,
      source: module.source,
      compilePath: module.compilePath ?? module.id,
      origin: "artifact",
    });
  };

  const hostStylesheet = (
    specifier: keyof TailwindStylesheets,
    source: string,
  ): SourceModule => {
    const id = `host:${specifier}`;
    files.set(id, source);
    return claim({
      id,
      legacyKey: id,
      kind: "css",
      source,
      compilePath: id,
      origin: "generated",
    });
  };

  const generatedModule = (id: ModuleId, legacyKey: string, code: string): SourceModule => {
    const known = claimed.get(id);
    const descriptor: Omit<SourceModule, "executionName"> = {
      id,
      legacyKey,
      kind: "js",
      source: code,
      compilePath: id,
      origin: "generated",
    };
    if (known !== undefined) {
      if (!sameDescriptor(descriptor, known)) {
        throw new ModuleIdentityCollisionError(id, "the generated module descriptors differ");
      }
      moduleNames.set(legacyKey, known.executionName);
      return known;
    }
    const executionName = claimBundleName(id, takenNames);
    const module: SourceModule = { ...descriptor, executionName };
    claimed.set(id, module);
    moduleNames.set(legacyKey, executionName);
    modules[executionName] = code;
    graphModules.push({
      identity: { id, compilePath: id, executionName },
      kind: "js",
      source: code,
    });
    return module;
  };

  let usesContent = false;
  /** The content config, seeded the moment something reaches for the content API. */
  let contentConfig: string | null = null;
  let usesImages = false;
  let usesImportMetaEnv = false;
  const usedEnv = new Set<string>();

  const readAssetInfo = (source: string): Promise<ProjectAssetInfo | null> => {
    let pending = assetInfos.get(source);
    if (pending === undefined) {
      pending = assets === undefined ? Promise.resolve(null) : Promise.resolve(assets.info(source));
      assetInfos.set(source, pending);
    }
    return pending;
  };

  const externalUse = (
    importer: SourceModule,
    rawSpecifier: string,
    external: string,
  ): ResolutionUse => {
    const alias = HOST_ALIASES.get(external);
    if (alias === undefined) {
      throw unresolvedImport(importer, rawSpecifier, `unsupported host external ${JSON.stringify(external)}`);
    }
    if (alias.kind === "content") {
      if (!usesContent) {
        usesContent = true;
        contentConfig = findContentConfig(projectFiles, options.srcDir);
        if (contentConfig !== null) projectModule(contentConfig);
      }
      return externalResolution(importer, rawSpecifier, external, CONTENT_MODULE_NAME);
    }
    if (alias.kind === "assets") {
      usesImages = true;
      addAssetSources(projectFiles, files);
      const target = projectModule(`${ASSETS_DIR}/index.ts`);
      if (target === null) throw unresolvedImport(importer, rawSpecifier, "generated asset entry is missing");
      return moduleResolution(importer, rawSpecifier, target);
    }
    if (alias.kind === "image") {
      usesImages = true;
      return externalResolution(importer, rawSpecifier, external, IMAGE_MODULE_NAME);
    }
    if (alias.kind === "env") {
      usedEnv.add(external);
      return externalResolution(importer, rawSpecifier, external, alias.executionName);
    }
    return externalResolution(importer, rawSpecifier, external, alias.executionName);
  };

  const resolveImport = async (
    importer: SourceModule,
    rawSpecifier: string,
  ): Promise<ResolutionUse> => {
    const resolved =
      importer.origin === "project"
        ? resolveSpecifier(importer.legacyKey, rawSpecifier)
        : rawSpecifier;

    if (importer.origin === "project") {
      const query = importQuery(resolved);
      if (query !== null) {
        const target = resolveInFiles(query.file, projectFiles);
        const source = target === null ? undefined : projectFiles.get(target);
        if (target === null || source === undefined) {
          throw unresolvedImport(importer, rawSpecifier, "query target does not exist");
        }
        const value = query.kind === "text" ? source : urlAssetHref(target, source, urlAssets);
        const code = `export default ${JSON.stringify(value)};\n`;
        const generated = generatedModule(
          `generated:query:${projectModuleId(target)}:${query.kind}`,
          resolved,
          code,
        );
        return moduleResolution(importer, rawSpecifier, generated);
      }

      const local = resolveInFiles(resolved, projectFiles);
      if (local !== null) {
        const target = projectModule(local);
        if (target === null) {
          throw unresolvedImport(importer, rawSpecifier, "the target kind is unsupported");
        }
        return moduleResolution(importer, rawSpecifier, target);
      }

      if (isImageSource(resolved)) {
        const info = await readAssetInfo(resolved);
        if (info === null) {
          throw unresolvedImport(importer, rawSpecifier, "the image metadata is missing or unreadable");
        }
        const code = imageModule(resolved, info);
        usesImages = true;
        return moduleResolution(
          importer,
          rawSpecifier,
          generatedModule(`generated:image:${projectModuleId(resolved)}`, resolved, code),
        );
      }

      if (PLETIVO_CONTENT_PATH.test(resolved)) {
        return externalUse(importer, rawSpecifier, "pletivo/content");
      }
    }

    const directAlias = HOST_ALIASES.get(rawSpecifier);
    if (directAlias !== undefined) return externalUse(importer, rawSpecifier, rawSpecifier);

    const frozen = artifact.resolve(importer.id, rawSpecifier);
    if (frozen !== null) {
      if (frozen.kind === "external") {
        return externalUse(importer, rawSpecifier, frozen.specifier);
      }
      return moduleResolution(importer, rawSpecifier, artifactModule(frozen.id));
    }

    if (importer.kind === "css" && isTailwindStylesheetSpecifier(rawSpecifier)) {
      if (options.tailwind === undefined) throw new TailwindNotConfiguredError(importer.id);
      return moduleResolution(
        importer,
        rawSpecifier,
        hostStylesheet(rawSpecifier, options.tailwind[rawSpecifier]),
      );
    }

    if (UNSUPPORTED_PACKAGE_ROOTS.has(rawSpecifier)) {
      throw unresolvedImport(importer, rawSpecifier, "unsupported package root export");
    }
    throw unresolvedImport(
      importer,
      rawSpecifier,
      "no project file, Artifact V2 resolution, or supported host alias answers it",
    );
  };

  /**
   * Everything about one file that depends only on its path, its bytes and the
   * compiler — which is all of the expensive work, and therefore all a cache holds.
   * What the file *set* decides is `applyCompiled` below.
   */
  const compileFile = async (module: SourceModule): Promise<CompiledFile> => {
    const { source, compilePath, kind } = module;
    if (kind === "js") return fileEntry(source, source, null, kind);
    if (kind === "json") {
      let value: unknown;
      try {
        value = JSON.parse(source);
      } catch (error) {
        throw new UnsupportedFileError(
          compilePath,
          `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return fileEntry(source, `export default ${JSON.stringify(value)};\n`, null, kind);
    }
    if (kind === "ts" || kind === "tsx" || kind === "jsx") {
      return fileEntry(
        source,
        transpile(source, { file: compilePath, jsx: kind === "tsx" || kind === "jsx" }),
        null,
        kind,
      );
    }

    const result = await compiler.transform(source, {
      filename: compilePath,
      internalURL: "pletivo/astro-shim",
      sourcemap: false,
      resolvePath: async (specifier) => specifier,
    });
    const errors = (result.diagnostics ?? []).filter((diagnostic) => diagnostic.severity === 1);
    if (errors.length > 0) {
      throw new UnsupportedFileError(
        compilePath,
        `the Astro compiler reported\n${errors.map((error) => `  ${error.text}`).join("\n")}`,
      );
    }

    let declared: AstroStyles | null = null;
    if (result.css.length > 0) {
      const blocks = await classifyStyles(result.css, source, compiler);
      if (blocks.length > 0) declared = { scope: result.scope, blocks };
    }

    // Types out before the graph is read: `import type` is not an edge, and with
    // `keepUnusedImports` nothing else in the prologue moves.
    return fileEntry(
      source,
      transpile(stripStyleImports(result.code), { file: compilePath }),
      declared,
      kind,
    );
  };

  /**
   * The half a cache hit still pays: everything that reads the file map rather than
   * one file's bytes. Measured at 2 ms for a whole project, which is why it is out
   * here — and why every side effect that rides on `resolve` is free on a hit.
   */
  const applyCompiled = async (module: SourceModule, entry: CompiledFile): Promise<void> => {
    const { legacyKey, executionName } = module;
    if (entry.importMetaEnv) usesImportMetaEnv = true;
    if (entry.styles !== null) styles.set(legacyKey, entry.styles);
    const bySpecifier = new Map<string, ResolutionUse>();
    const executionTargets: string[] = [];
    const styleTargets: string[] = [];
    const seenExecution = new Set<string>();
    const seenStyles = new Set<string>();
    for (const specifier of entry.specifiers) {
      let use = bySpecifier.get(specifier);
      if (use === undefined) {
        use = await resolveImport(module, specifier);
        bySpecifier.set(specifier, use);
        graphEdges.push(use.edge);
      }
      if (use.edge.target.kind === "external") {
        const alias = HOST_ALIASES.get(use.edge.target.specifier);
        if (alias?.kind === "env") {
          const into = envNames.get(use.edge.target.specifier);
          const importedNames = entry.envNames?.get(specifier) ?? [];
          if (into !== undefined) for (const imported of importedNames) into.add(imported);
        }
      }
      if (use.targetLegacyKey === null) continue;
      if (use.edge.kind === "style") {
        if (!seenStyles.has(use.targetLegacyKey)) styleTargets.push(use.targetLegacyKey);
        seenStyles.add(use.targetLegacyKey);
      } else {
        if (!seenExecution.has(use.targetLegacyKey)) executionTargets.push(use.targetLegacyKey);
        seenExecution.add(use.targetLegacyKey);
      }
    }
    imports.set(legacyKey, executionTargets);
    cssImports.set(legacyKey, styleTargets);
    const compiledCode = module.kind === "astro"
      ? replaceAstroTrackingId(entry.code ?? entry.source, module.compilePath, module.id)
      : (entry.code ?? entry.source);
    modules[executionName] = rewriteImports(compiledCode, {
      importer: module.compilePath,
      resolve(_resolved, specifier) {
        const use = bySpecifier.get(specifier);
        if (use === undefined) {
          throw unresolvedImport(module, specifier, "rewrite did not see the canonical resolution");
        }
        return use.rewritten;
      },
    });
  };

  const compileOne = async (pending: Pending): Promise<void> => {
    const { module } = pending;

    // A resolvable stub: no code to compile, no edges to record, nothing to cache.
    if (module.kind === "css") {
      const targets: string[] = [];
      const seen = new Set<string>();
      for (const specifier of collectCssSpecifiers(module.source)) {
        const use = await resolveImport(module, specifier);
        graphEdges.push(use.edge);
        if (use.edge.kind !== "style" || use.targetLegacyKey === null) {
          throw unresolvedImport(module, specifier, "CSS @import must resolve to a CSS module");
        }
        if (!seen.has(use.targetLegacyKey)) targets.push(use.targetLegacyKey);
        seen.add(use.targetLegacyKey);
      }
      imports.set(module.legacyKey, []);
      cssImports.set(module.legacyKey, targets);
      modules[module.executionName] = "export {};\n";
      return;
    }

    const held = cache?.get(module.compilePath);
    let entry =
      held !== undefined && held.source === module.source && held.kind === module.kind
        ? held
        : undefined;
    if (entry === undefined) {
      entry = await compileFile(module);
      // Written only once the file has fully compiled, so a compiler diagnostic or a
      // sucrase failure never poisons an entry.
      cache?.set(module.compilePath, entry);
    }
    await applyCompiled(module, entry);
  };

  // Materialised before the walk, because `files` can gain the `astro:assets` sources
  // part-way through it.
  const seeds = (options.entries ?? [...projectFiles.keys()]).map(normalizeProjectPath);
  const entries: string[] = [];
  for (const seed of seeds) {
    const module = projectModule(seed);
    if (module === null) continue;
    entries.push(seed);
  }

  // An index cursor rather than `shift()`: `resolve` runs inside `rewriteImports`, so
  // compiling one file appends the files it imports to the queue being walked.
  for (let index = 0; index < queue.length; index++) {
    await compileOne(queue[index]);
  }

  let content: ProjectContent | null = null;
  if (usesContent) {
    modules[CONTENT_MODULE_NAME] = GENERATED_MODULES[CONTENT_MODULE_NAME];
    const configFile = contentConfig;
    content = { configModule: configFile === null ? null : (moduleNames.get(configFile) ?? null) };
  }
  // The content runtime needs it too: an `image()` schema names the output file, and
  // `imageOutputPath` is what names it on both hosts.
  if (usesImages || usesContent) modules[IMAGE_MODULE_NAME] = GENERATED_MODULES[IMAGE_MODULE_NAME];

  const env = envUse(usedEnv, envNames);
  const requirements = {
    content: content === null ? null : { configExecutionName: content.configModule },
    images: usesImages || usesContent,
    importMetaEnv: usesImportMetaEnv,
    env,
  };
  const programEntries = entries.map((file) => {
    const executionName = moduleNames.get(file);
    if (executionName === undefined) {
      throw new UnsupportedFileError(file, "the compiled entry has no execution name");
    }
    return { moduleId: projectModuleId(file), executionName };
  });
  const program: ExecutableProgram = {
    mainModule: "pletivo-entry.js",
    modules,
    entries: programEntries,
    requirements,
  };
  const executionEdges = graphEdges
    .filter((edge) => edge.kind === "execution" && edge.target.kind === "module")
    .map((edge) => ({ importer: edge.importer, target: moduleTargetId(edge.target) }));
  const styleEdges = graphEdges
    .filter((edge) => edge.kind === "style" && edge.target.kind === "module")
    .map((edge) => ({ importer: edge.importer, target: moduleTargetId(edge.target) }));
  const styleGraph: ResolvedStyleGraph = {
    modules: graphModules.map((module) => module.identity.id),
    executionEdges,
    styleEdges,
    styles: graphModules.flatMap((module) => {
      const declared = styles.get(sourceLegacyKey(module.identity.id, claimed));
      return declared === undefined
        ? []
        : [{ moduleId: module.identity.id, scope: declared.scope, blocks: declared.blocks }];
    }),
  };
  return {
    modules,
    sources: files,
    moduleNames,
    entries,
    styles,
    imports,
    cssImports,
    content,
    images: usesImages || usesContent,
    importMetaEnv: usesImportMetaEnv,
    env,
    urlAssets,
    program,
    styleGraph,
    graph: { modules: graphModules, edges: graphEdges },
  };
}

function collectCssSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const pattern = /@import\s+(?:url\(\s*)?["']([^"']+)["']\s*\)?/g;
  for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  return specifiers;
}

/**
 * `import.meta.env`, which a Worker Loader module does not have.
 *
 * Vite gives every module one; V8 hands `import.meta` to the *host*, so nothing a
 * generated module could assign would be visible to another module's `import.meta`.
 * The only way to answer it is the way Vite does — substitution — and this is it, with
 * the values behind a global so a rotated secret does not recompile the project.
 *
 * A textual replacement, and it says so: the same three tokens inside a string literal
 * are rewritten too. That is Vite's own failure mode with `define`, and the shape of
 * the mistake is visible in the output rather than silent. It runs after sucrase, on
 * generated JavaScript, so `.astro` frontmatter and `.tsx` are covered by one pass.
 */
const IMPORT_META_ENV = /\bimport\s*\.\s*meta\s*\.\s*env\b/g;

function substituteImportMetaEnv(code: string): { code: string; used: boolean } {
  if (!IMPORT_META_ENV.test(code)) return { code, used: false };
  IMPORT_META_ENV.lastIndex = 0;
  return { code: code.replace(IMPORT_META_ENV, `globalThis.${IMPORT_META_ENV_GLOBAL}`), used: true };
}

/**
 * One cache entry, from the two texts the rest of the compile needs.
 *
 * `text` is the file's JavaScript *before* substitution — the raw source for `.js`, the
 * transpiled code for the rest — and it is what the specifiers and the `astro:env`
 * names are read off. `code` is the substituted one, which is what `rewriteImports`
 * runs over. Two texts, not one: the specifier collection must not see
 * `import.meta.env` rewritten. `code` is `null` when substitution did not fire and the
 * text *is* the source, so a plain `.js` module costs a pointer.
 */
function fileEntry(
  source: string,
  text: string,
  styles: AstroStyles | null,
  kind: ArtifactModuleKind,
): CompiledFile {
  const substituted = substituteImportMetaEnv(text);
  const specifiers = collectSpecifiers(text);
  return {
    source,
    kind,
    code: substituted.code === source ? null : substituted.code,
    importMetaEnv: substituted.used,
    specifiers,
    envNames: envNamesOf(text, specifiers),
    styles,
  };
}

/**
 * The names one file takes from `astro:env/client` and `astro:env/server`.
 *
 * Carried per file rather than accumulated in the walk, because the walk is what a
 * cache hit skips — and these are the generated module's export list, so a dropped
 * name is the isolate refusing to start rather than an undefined value.
 */
function envNamesOf(
  text: string,
  specifiers: readonly string[],
): ReadonlyMap<string, readonly string[]> | null {
  let names: Map<string, readonly string[]> | null = null;
  for (const specifier of new Set(specifiers)) {
    const imported = collectImportedNames(text, specifier);
    if (imported.length === 0) continue;
    (names ??= new Map()).set(specifier, imported);
  }
  return names;
}

/**
 * One image's module, holding what the Bun host's loader puts in the same place.
 *
 * `fsPath` is the file-map key rather than a filesystem path — it is what `getImage()`
 * tests to tell an ESM-imported image from a bare string, and what a host resolves
 * back to bytes when the browser asks for the URL. Non-enumerable, exactly as on the
 * Bun host, so it cannot leak through `JSON.stringify`.
 *
 * The view already validated the metadata. A missing or unreadable image fails in
 * the canonical resolver before this module is created.
 */
function imageModule(file: string, info: ProjectAssetInfo): string {
  const visible = {
    src: `/${imageOutputPath(file, info.hash)}`,
    width: info.width,
    height: info.height,
    format: info.format,
  };
  return (
    `const meta = ${JSON.stringify(visible)};\n` +
    `Object.defineProperty(meta, "fsPath", { value: ${JSON.stringify(file)}, enumerable: false });\n` +
    "export default meta;\n"
  );
}

const IMAGE_SOURCE_EXTENSIONS = new Set([
  ".avif",
  ".gif",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".webp",
]);

function isImageSource(file: string): boolean {
  return IMAGE_SOURCE_EXTENSIONS.has(extensionOf(file));
}

/**
 * Which `astro:env` modules the bundle needs, and the names each has to export.
 *
 * A specifier that was resolved but named nothing — a namespace import, a dynamic
 * `import()` — still yields an entry, with an empty list: the module has to exist, it
 * just takes its whole surface from what the host provided.
 */
function envUse(used: Set<string>, names: Map<string, Set<string>>): ProjectEnvUse | null {
  if (used.size === 0) return null;
  const of = (specifier: string): string[] | null =>
    used.has(specifier) ? [...(names.get(specifier) ?? [])].sort() : null;
  return { client: of(ENV_CLIENT_SPECIFIER), server: of(ENV_SERVER_SPECIFIER) };
}

/**
 * `stripTypes`, reported as an unsupported file.
 *
 * For `.astro` the position sucrase reports counts lines in the *compiled* module,
 * not in the source the author wrote — and the compiler puts the whole template on
 * one line — so an unqualified "(3:14)" points at a file nobody has. Say so.
 */
function transpile(code: string, options: { file: string; jsx?: boolean }): string {
  try {
    return stripTypes(code, options);
  } catch (error) {
    if (!(error instanceof TranspileError)) throw error;
    const detail = error.cause instanceof Error ? error.cause.message : String(error.cause);
    const where = options.file.endsWith(COMPILED)
      ? " (position is in the compiled output, not the .astro source)"
      : "";
    throw new UnsupportedFileError(options.file, detail + where);
  }
}
