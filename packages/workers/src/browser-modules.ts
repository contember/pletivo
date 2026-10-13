/**
 * Processed `<script>` blocks, served to the browser unbundled, the way a Vite dev
 * server serves them: each script and each module it reaches is its own ES module, with
 * imports rewritten to URLs this host answers. A script edit needs no build step.
 *
 * - `/_pletivo/script/<index>/<module>` — script `<index>` of a `.astro` module.
 * - `/_pletivo/module/<module>` — a project file, or a package module from the
 *   artifact's browser graph (`browserResolutions`).
 *
 * `<module>` is the ModuleId with its first `:` as `/`, each segment URL-encoded.
 */

import type { ModuleId } from "@pletivo/core/artifact";
import { md5Hex } from "@pletivo/core/md5";
import { executionNameForModuleId, projectModuleId, type ProjectArtifact } from "./artifact.ts";
import type { AstroCompiler } from "./astro-compiler.ts";
import type { CompileCache } from "./compile-cache.ts";
import type { ProgramScript } from "./compiled-program.ts";
import { bundled, compileCached } from "./compile/compile-file.ts";
import { extensionOf, projectModuleKind } from "./compile/module-kind.ts";
import { resolveInFiles } from "./compile/resolve-in-files.ts";
import { collectImports, resolveSpecifier, rewriteImports } from "./rewrite-imports.ts";
import type { ProjectFiles } from "./project-store.ts";
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

/** What a browser-module request needs from the project as one snapshot sees it. */
export interface BrowserModuleSource {
  files: ProjectFiles;
  artifact?: ProjectArtifact;
  compiler?: AstroCompiler;
  compileCache?: CompileCache;
  /** As the page was compiled, so a shared cache entry is reused rather than replaced. */
  annotateSourceFile?: boolean;
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

/** Whether this host answers `pathname` with a browser module. */
export function isBrowserModulePath(pathname: string): boolean {
  return pathname.startsWith(SCRIPT_PREFIX) || pathname.startsWith(MODULE_PREFIX);
}

/** The JavaScript `pathname` names. Throws `BrowserModuleError` with the status to answer. */
export async function browserModule(pathname: string, project: BrowserModuleSource): Promise<string> {
  if (pathname.startsWith(SCRIPT_PREFIX)) {
    const rest = pathname.slice(SCRIPT_PREFIX.length);
    const slash = rest.indexOf("/");
    const index = Number(rest.slice(0, slash));
    if (slash <= 0 || !Number.isInteger(index) || index < 0 || !rest.endsWith(".js")) {
      throw new BrowserModuleError(pathname, "not a script URL", 404);
    }
    const moduleId = moduleIdOf(rest.slice(slash + 1, -".js".length), pathname);
    const code = await scriptCode(moduleId, index, project, pathname);
    return rewriteForBrowser(stripTypes(code, { file: moduleId }), moduleId, project, pathname);
  }
  if (pathname.startsWith(MODULE_PREFIX)) {
    const moduleId = moduleIdOf(pathname.slice(MODULE_PREFIX.length), pathname);
    return moduleCode(moduleId, project, pathname);
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
    project.compiler ?? bundled,
    project.compileCache,
    project.annotateSourceFile === true,
  );
  const code = compiled.scripts[index];
  if (code === undefined || code === null) {
    throw new BrowserModuleError(pathname, `${moduleId} has no processed script ${index}`, 404);
  }
  return code;
}

async function moduleCode(moduleId: ModuleId, project: BrowserModuleSource, pathname: string): Promise<string> {
  const located = locate(moduleId, project, pathname);
  if (located.kind === "css") {
    // A stylesheet a script imports is applied when the import runs, as Vite dev does.
    return (
      `const style = document.createElement("style");\n` +
      `style.dataset.pletivoModule = ${JSON.stringify(moduleId)};\n` +
      `style.textContent = ${JSON.stringify(located.source)};\n` +
      `document.head.append(style);\n`
    );
  }
  if (located.kind === "json") return `export default ${located.source.trim() || "null"};\n`;
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
function rewriteForBrowser(
  code: string,
  importer: ModuleId,
  project: BrowserModuleSource,
  pathname: string,
): string {
  const importerFile = importer.startsWith("project:") ? importer.slice("project:".length) : null;
  return rewriteImports(code, {
    importer: importerFile ?? importer,
    resolve(resolved, specifier) {
      if (importerFile !== null && (specifier.startsWith(".") || specifier.startsWith("/"))) {
        const file = resolveInFiles(specifier.startsWith("/") ? specifier.slice(1) : resolved, project.files);
        if (file === null) {
          throw new BrowserModuleError(pathname, `${importer} imports ${JSON.stringify(specifier)}, which is no project file`, 500);
        }
        return moduleUrl(projectModuleId(file));
      }
      const target = project.artifact?.browserResolver.resolve(importer, specifier) ?? null;
      if (target === null || target.kind !== "module") {
        throw new BrowserModuleError(
          pathname,
          `${importer} imports ${JSON.stringify(specifier)}, which the artifact's browser graph does not carry; ` +
            "re-run `pletivo prepare`",
          500,
        );
      }
      return moduleUrl(target.id);
    },
  });
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
