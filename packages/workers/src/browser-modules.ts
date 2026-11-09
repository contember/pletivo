/**
 * Processed `<script>` blocks, served to the browser unbundled, the way a Vite dev
 * server serves them: each script and each module it reaches is its own ES module, with
 * imports rewritten to URLs this host answers. A script edit needs no build step.
 *
 * - `/_pletivo/script/<index>/<module>` — script `<index>` of a `.astro` module. A page names
 *   it with `?v=<digest of the code served>`, so what it serves at that URL never changes.
 * - `/_pletivo/module/<module>` — a project file, or a package module from the
 *   artifact's browser graph (`browserResolutions`). A package module's URL carries
 *   `?v=<browser graph version>`, so what it serves at that URL never changes.
 *
 * `<module>` is the ModuleId with its first `:` as `/`, each segment URL-encoded.
 */

import type { ModuleId } from "@pletivo/core/artifact";
import { browserStylesheetModule } from "@pletivo/core/browser-stylesheet";
import { md5Hex } from "@pletivo/core/md5";
import { executionNameForModuleId, projectModuleId, type ProjectArtifact } from "./artifact.ts";
import type { AstroCompiler } from "./astro-compiler.ts";
import type { CompileCache } from "./compile-cache.ts";
import type { ProgramScript } from "./compiled-program.ts";
import { compileCached } from "./compile/compile-file.ts";
import { extensionOf, projectModuleKind } from "./compile/module-kind.ts";
import { resolveInFiles } from "./compile/resolve-in-files.ts";
import { collectImports, resolveSpecifier, rewriteImports } from "./rewrite-imports.ts";
import { WorkspaceSnapshotChangedError, type ProjectFiles } from "./project-store.ts";
import { stripTypes } from "./transpile.ts";

export const SCRIPT_PREFIX = "/_pletivo/script/";
export const MODULE_PREFIX = "/_pletivo/module/";

/** The id `$$renderScript` is called with for script `index` of a file compiled as `compilePath`. */
export function scriptId(compilePath: string, index: number): string {
  return `${compilePath}?astro&type=script&index=${index}&lang.ts`;
}

/** Where the browser loads script `index` of `moduleId`. The query changes with the code. */
export function scriptUrl(moduleId: ModuleId, index: number, code: string): string {
  return `${SCRIPT_PREFIX}${index}/${modulePath(moduleId)}.js?v=${md5Hex(code).slice(0, 8)}`;
}

export function moduleUrl(moduleId: ModuleId): string {
  return `${MODULE_PREFIX}${modulePath(moduleId)}`;
}

/**
 * What an artifact module is served as, besides the artifact: how its imports are rewritten, how it is
 * wrapped. Bump it with any change to that, since a browser keeps a versioned artifact module forever.
 */
export const BROWSER_MODULE_FORMAT = 1;

/** An artifact's browser graph: the modules a browser loads from it, and the version their URLs carry. */
export interface BrowserGraph {
  /**
   * A digest of all those modules' served code is made of: the graph's modules and resolutions, and
   * `BROWSER_MODULE_FORMAT`. A package's own digest in its ModuleId does not do: it names the package,
   * not what its imports resolve to in this artifact.
   */
  version: string;
  /** The artifact modules a browser import resolves to; no other module is served at a version. */
  modules: ReadonlySet<ModuleId>;
}

const browserGraphs = new WeakMap<ProjectArtifact, Promise<BrowserGraph>>();

/** Once per artifact: the first page's preload walk waits for it, so it is a native digest. */
export function browserGraphOf(artifact: ProjectArtifact): Promise<BrowserGraph> {
  let graph = browserGraphs.get(artifact);
  if (graph === undefined) {
    graph = digestBrowserGraph(artifact);
    browserGraphs.set(artifact, graph);
  }
  return graph;
}

async function digestBrowserGraph(artifact: ProjectArtifact): Promise<BrowserGraph> {
  const resolutions = artifact.prepared.artifact.browserResolutions ?? [];
  const parts = [String(BROWSER_MODULE_FORMAT), JSON.stringify(resolutions)];
  const modules = new Set<ModuleId>();
  for (const resolution of resolutions) {
    if (resolution.target.kind === "module" && !resolution.target.id.startsWith("project:")) modules.add(resolution.target.id);
  }
  for (const id of [...modules].sort()) {
    const module = artifact.browserResolver.module(id);
    parts.push(JSON.stringify([id, module?.kind ?? null, module?.compilePath ?? null, module?.source ?? null]));
  }
  return { version: await shortDigest(parts.join("\n")), modules };
}

/** The first 8 bytes of the text's SHA-256, as hex. */
async function shortDigest(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...digest.subarray(0, 8)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** What a browser-module request needs from the project as one snapshot sees it. */
export interface BrowserModuleSource {
  files: ProjectFiles;
  artifact?: ProjectArtifact;
  compiler: AstroCompiler;
  compileCache?: CompileCache;
  /** As the page was compiled, so a shared cache entry is reused rather than replaced. */
  annotateSourceFile?: boolean;
  /**
   * What each project module and script URL statically imports, kept by the caller for one
   * file set and artifact. `staticModuleGraph` reads it and fills it in.
   */
  staticImports?: Map<string, readonly string[]>;
  /** The digest of the code each script URL serves, kept by the caller like `staticImports`. `pinScriptUrls` fills it in. */
  scriptVersions?: Map<string, string>;
}

/** A request outside the browser-module namespace, or a malformed one. */
export class BrowserModuleError extends Error {
  constructor(
    readonly pathname: string,
    reason: string,
    readonly status: 404 | 500,
  ) {
    super(`[pletivo-workers] cannot serve ${JSON.stringify(pathname)} to the browser: ${reason}`);
    this.name = "BrowserModuleError";
  }
}

/** An import the artifact's browser graph does not carry, so `pletivo prepare` must run again. */
export class UnresolvedBrowserImportError extends BrowserModuleError {
  constructor(
    pathname: string,
    readonly importer: ModuleId,
    readonly specifier: string,
  ) {
    super(
      pathname,
      `${importer} imports ${JSON.stringify(specifier)}, which the artifact's browser graph does not carry; ` +
        "re-run `pletivo prepare`",
      500,
    );
    this.name = "UnresolvedBrowserImportError";
  }
}

/** Whether this host answers `pathname` with a browser module. */
export function isBrowserModulePath(pathname: string): boolean {
  return pathname.startsWith(SCRIPT_PREFIX) || pathname.startsWith(MODULE_PREFIX);
}

/**
 * The JavaScript `url` names, and whether it is served for good: an artifact module of the browser
 * graph, asked for at the graph's version. Throws `BrowserModuleError` with the status to answer.
 */
export async function browserModule(url: URL, project: BrowserModuleSource): Promise<{ code: string; immutable: boolean }> {
  const served = await servedModule(url.pathname, project);
  return { code: served.code, immutable: served.version !== null && url.searchParams.get("v") === served.version };
}

/**
 * Each of a page's script URLs pinned to the code it serves now: `?v=` is that code's digest, at which
 * the host serves it for good. The code is the script with its imports rewritten, so a moved import
 * target or a new browser graph version gives a new URL. A script that cannot be served keeps its URL;
 * the browser's own request reports why.
 */
export async function pinScriptUrls(urls: readonly string[], project: BrowserModuleSource): Promise<Map<string, string>> {
  const pinned = new Map<string, string>();
  await Promise.all(
    urls.map(async (url) => {
      const query = url.indexOf("?");
      const pathname = query === -1 ? url : url.slice(0, query);
      if (!pathname.startsWith(SCRIPT_PREFIX)) return;
      let version = project.scriptVersions?.get(pathname);
      if (version === undefined) {
        let served: ServedModule;
        try {
          served = await servedModule(pathname, project);
        } catch (error) {
          if (error instanceof WorkspaceSnapshotChangedError) throw error;
          return;
        }
        if (served.version === null) return;
        version = served.version;
        project.scriptVersions?.set(pathname, version);
      }
      pinned.set(url, `${pathname}?v=${version}`);
    }),
  );
  return pinned;
}

/**
 * The browser modules `entries` reach through static imports, entries included: each URL
 * once, after the modules it imports. What a page's `<link rel="modulepreload">` hints name.
 * A module that cannot be served is left out; the browser's own request reports why.
 */
export async function staticModuleGraph(entries: readonly string[], project: BrowserModuleSource): Promise<string[]> {
  // Every module is read at once; only the order below is depth-first.
  const loading = new Map<string, Promise<readonly string[] | null>>();
  function load(url: string): Promise<unknown> {
    if (loading.has(url)) return Promise.resolve();
    const imports = staticImportsOf(url, project);
    loading.set(url, imports);
    return imports.then((targets) => Promise.all((targets ?? []).map(load)));
  }
  await Promise.all(entries.map(load));
  const importsOf = new Map<string, readonly string[] | null>();
  for (const [url, imports] of loading) importsOf.set(url, await imports);

  const order: string[] = [];
  const seen = new Set<string>();
  function visit(url: string): void {
    if (seen.has(url)) return;
    seen.add(url);
    const imports = importsOf.get(url);
    if (imports === null || imports === undefined) return;
    for (const target of imports) visit(target);
    order.push(url);
  }
  for (const entry of entries) visit(entry);
  return order;
}

/** Per artifact, what each of its modules statically imports: a function of the artifact alone. */
const artifactModuleImports = new WeakMap<ProjectArtifact, Map<string, readonly string[]>>();

async function staticImportsOf(url: string, project: BrowserModuleSource): Promise<readonly string[] | null> {
  const query = url.indexOf("?");
  const pathname = query === -1 ? url : url.slice(0, query);
  const memo = artifactMemo(pathname, project.artifact) ?? project.staticImports;
  const held = memo?.get(pathname);
  if (held !== undefined) return held;
  let served: ServedModule;
  try {
    served = await servedModule(pathname, project);
  } catch (error) {
    if (error instanceof WorkspaceSnapshotChangedError) throw error;
    return null;
  }
  memo?.set(pathname, served.staticImports);
  return served.staticImports;
}

const PROJECT_MODULE_PREFIX = `${MODULE_PREFIX}project/`;

/** Where an artifact module's static imports are kept, across file sets; `null` for a project file or a script. */
function artifactMemo(pathname: string, artifact: ProjectArtifact | undefined): Map<string, readonly string[]> | null {
  if (artifact === undefined || !pathname.startsWith(MODULE_PREFIX) || pathname.startsWith(PROJECT_MODULE_PREFIX)) return null;
  let memo = artifactModuleImports.get(artifact);
  if (memo === undefined) {
    memo = new Map();
    artifactModuleImports.set(artifact, memo);
  }
  return memo;
}

/** What one browser-module URL serves, and the URLs its static imports load. */
/** A module's code with its imports rewritten, and the URLs its static imports load. */
interface RewrittenModule {
  code: string;
  staticImports: readonly string[];
}

interface ServedModule {
  code: string;
  staticImports: readonly string[];
  /**
   * The version this module is served for good at: a script's code digest, an artifact module's browser
   * graph version; null for a project file or a module outside the graph.
   */
  version: string | null;
}

async function servedModule(pathname: string, project: BrowserModuleSource): Promise<ServedModule> {
  if (pathname.startsWith(SCRIPT_PREFIX)) {
    const rest = pathname.slice(SCRIPT_PREFIX.length);
    const slash = rest.indexOf("/");
    const index = Number(rest.slice(0, slash));
    if (slash <= 0 || !Number.isInteger(index) || index < 0 || !rest.endsWith(".js")) {
      throw new BrowserModuleError(pathname, "not a script URL", 404);
    }
    const moduleId = moduleIdOf(rest.slice(slash + 1, -".js".length), pathname);
    const code = await scriptCode(moduleId, index, project, pathname);
    const rewritten = await rewriteForBrowser(stripTypes(code, { file: moduleId }), moduleId, project, pathname);
    return { ...rewritten, version: await shortDigest(rewritten.code) };
  }
  if (pathname.startsWith(MODULE_PREFIX)) {
    const moduleId = moduleIdOf(pathname.slice(MODULE_PREFIX.length), pathname);
    const served = await moduleCode(moduleId, project, pathname);
    // Decided on the decoded id: an encoded `project` segment names a project file all the same.
    const graph = project.artifact === undefined || moduleId.startsWith("project:") ? null : await browserGraphOf(project.artifact);
    return { ...served, version: graph !== null && graph.modules.has(moduleId) ? graph.version : null };
  }
  throw new BrowserModuleError(pathname, "not a browser module URL", 404);
}

/** Script bodies and the project files they reach: where a script names Tailwind classes. */
export function scriptCandidateSources(scripts: Iterable<ProgramScript>, files: ProjectFiles): string[] {
  const sources: string[] = [];
  const queue: { importer: string | null; code: string }[] = [];
  for (const script of scripts) {
    sources.push(script.code);
    const importer = script.moduleId.startsWith("project:") ? script.compilePath : null;
    queue.push({ importer, code: script.code });
  }
  const seen = new Set<string>();
  while (queue.length > 0) {
    const next = queue.pop();
    if (next === undefined) break;
    const { importer } = next;
    if (importer === null) continue;
    let specifiers: string[];
    try {
      specifiers = collectImports(stripTypes(next.code, { file: importer })).specifiers;
    } catch {
      // A script that does not parse fails where it is served; it names no classes here.
      continue;
    }
    for (const specifier of specifiers) {
      if (!specifier.startsWith(".")) continue;
      const file = resolveInFiles(resolveSpecifier(importer, specifier), files);
      if (file === null || seen.has(file)) continue;
      seen.add(file);
      const source = files.get(file);
      if (source === undefined) continue;
      sources.push(source);
      queue.push({ importer: file, code: source });
    }
  }
  return sources;
}

async function scriptCode(
  moduleId: ModuleId,
  index: number,
  project: BrowserModuleSource,
  pathname: string,
): Promise<string> {
  const located = locate(moduleId, project, pathname);
  if (located.kind !== "astro") throw new BrowserModuleError(pathname, `${moduleId} is not an .astro module`, 404);
  const compiled = await compileCached(
    {
      id: moduleId,
      kind: "astro",
      source: located.source,
      compilePath: located.compilePath,
      executionName: executionNameForModuleId(moduleId),
      origin: located.origin,
    },
    project.compiler,
    project.compileCache,
    project.annotateSourceFile === true,
  );
  const code = compiled.scripts[index];
  if (code === undefined || code === null) {
    throw new BrowserModuleError(pathname, `${moduleId} has no processed script ${index}`, 404);
  }
  return code;
}

async function moduleCode(moduleId: ModuleId, project: BrowserModuleSource, pathname: string): Promise<RewrittenModule> {
  const located = locate(moduleId, project, pathname);
  if (located.kind === "css") return { code: browserStylesheetModule(moduleId, located.source), staticImports: [] };
  if (located.kind === "json") return { code: `export default ${located.source.trim() || "null"};\n`, staticImports: [] };
  if (located.kind === "js" || located.kind === "ts") {
    const code = located.kind === "ts" ? stripTypes(located.source, { file: located.compilePath }) : located.source;
    return rewriteForBrowser(code, moduleId, project, pathname);
  }
  throw new BrowserModuleError(pathname, `a .${located.kind} module cannot run in the browser`, 500);
}

interface LocatedModule {
  kind: string;
  source: string;
  compilePath: string;
  origin: "project" | "artifact";
}

function locate(moduleId: ModuleId, project: BrowserModuleSource, pathname: string): LocatedModule {
  if (moduleId.startsWith("project:")) {
    const file = moduleId.slice("project:".length);
    const source = project.files.get(file);
    const kind = projectModuleKind(file);
    if (source === undefined || kind === null) throw new BrowserModuleError(pathname, `no project file ${file}`, 404);
    return { kind, source, compilePath: file, origin: "project" };
  }
  const module = project.artifact?.resolver.module(moduleId) ?? null;
  if (module === null) throw new BrowserModuleError(pathname, `no artifact module ${moduleId}`, 404);
  return { kind: module.kind, source: module.source, compilePath: module.compilePath ?? module.id, origin: "artifact" };
}

/** Every import of `code` as a URL this host answers, or a 500 naming the first it cannot. */
async function rewriteForBrowser(
  code: string,
  importer: ModuleId,
  project: BrowserModuleSource,
  pathname: string,
): Promise<RewrittenModule> {
  const version = project.artifact === undefined ? null : (await browserGraphOf(project.artifact)).version;
  const importerFile = importer.startsWith("project:") ? importer.slice("project:".length) : null;
  const staticImports: string[] = [];
  function urlOf(resolved: string, specifier: string): string {
    if (importerFile !== null && (specifier.startsWith(".") || specifier.startsWith("/"))) {
      const file = resolveInFiles(specifier.startsWith("/") ? specifier.slice(1) : resolved, project.files);
      if (file === null) {
        throw new BrowserModuleError(pathname, `${importer} imports ${JSON.stringify(specifier)}, which is no project file`, 500);
      }
      return moduleUrl(projectModuleId(file));
    }
    const target = project.artifact?.browserResolver.resolve(importer, specifier) ?? null;
    if (version === null || target === null || target.kind !== "module") throw new UnresolvedBrowserImportError(pathname, importer, specifier);
    if (target.id.startsWith("project:")) return moduleUrl(target.id);
    return `${moduleUrl(target.id)}?v=${version}`;
  }
  const rewritten = rewriteImports(code, {
    importer: importerFile ?? importer,
    resolve(resolved, specifier, kind) {
      const url = urlOf(resolved, specifier);
      if (kind === "static") staticImports.push(url);
      return url;
    },
  });
  // `rewriteImports` resolves the last import first.
  return { code: rewritten, staticImports: [...new Set(staticImports.reverse())] };
}

function modulePath(moduleId: ModuleId): string {
  const colon = moduleId.indexOf(":");
  const namespace = moduleId.slice(0, colon);
  const rest = moduleId.slice(colon + 1);
  return [namespace, ...rest.split("/")].map(encodeURIComponent).join("/");
}

function moduleIdOf(path: string, pathname: string): ModuleId {
  let segments: string[];
  try {
    segments = path.split("/").map(decodeURIComponent);
  } catch {
    throw new BrowserModuleError(pathname, "malformed module path", 404);
  }
  const [namespace, ...rest] = segments;
  if (namespace === undefined || rest.length === 0 || rest.some((segment) => segment === "" || segment === "..")) {
    throw new BrowserModuleError(pathname, "malformed module path", 404);
  }
  if (namespace === "project" && extensionOf(rest.join("/")) === "") {
    throw new BrowserModuleError(pathname, "a project module path names a file", 404);
  }
  return `${namespace}:${rest.join("/")}`;
}
