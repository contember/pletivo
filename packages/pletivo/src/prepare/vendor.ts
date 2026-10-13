/** Close every non-project import into artifact modules and resolutions. */

import fs from "node:fs/promises";
import path from "node:path";
import {
  ANY_PROJECT_IMPORTER,
  type ArtifactModule,
  type ArtifactModuleKind,
  type ArtifactResolution,
  type ArtifactResolutionTarget,
  type ModuleId,
} from "@pletivo/core/artifact";
import { prepareFailure, PrepareError } from "./error";
import { compareStrings, isInsideRoot, isMissingFile, normalizePath } from "./paths";
import {
  classifySpecifier,
  extensionOf,
  ImportScanError,
  specifiersOf,
} from "./scan";

export interface ProjectImportSource {
  id: ModuleId;
  file: string;
  source: string;
  /** Processed `<script>` bodies of an `.astro` file, which run in the browser. */
  scripts?: readonly string[];
}

export interface FrozenVirtualSource {
  id: string;
  code: string;
}

export type FreezeVirtualSource = (
  specifier: string,
  importer: string,
) => Promise<FrozenVirtualSource | null>;

export interface PreparedGraph {
  modules: ArtifactModule[];
  resolutions: ArtifactResolution[];
  browserResolutions: ArtifactResolution[];
}

interface ImportRequest {
  importer: ModuleId;
  importerFile: string;
  resolveFrom: string;
  relativeViaVite: boolean;
  stylesheet: boolean;
  specifier: string;
}

interface PackageIdentity {
  digest: string;
  root: string;
}

interface PackageRecord {
  root: string;
  manifest: unknown;
}

const WORKER_EXPORT_CONDITIONS = ["workerd", "worker", "browser", "import", "default"];
const STYLESHEET_EXPORT_CONDITIONS = ["style", ...WORKER_EXPORT_CONDITIONS];
const BROWSER_EXPORT_CONDITIONS = ["browser", "import", "default"];

/** Build the artifact-owned part of the project graph. */
export async function prepareModuleGraph(
  root: string,
  projectSources: readonly ProjectImportSource[],
  freezeVirtual: FreezeVirtualSource,
  /** Bare specifiers the config names (portable plugins), resolved from the project root. */
  configImports: readonly string[] = [],
): Promise<PreparedGraph> {
  const carried = new CarriedModules(root);
  const { modules } = carried;
  const resolutions: ArtifactResolution[] = [];
  const queue: ImportRequest[] = [];
  const seenRequests = new Map<ModuleId, Set<string>>();

  const enqueueImports = (
    importer: ModuleId,
    importerFile: string,
    resolveFrom: string,
    relativeViaVite: boolean,
    stylesheet: boolean,
    source: string,
    moduleKind?: ArtifactModuleKind,
  ): void => {
    try {
      for (const specifier of specifiersOf(importerFile, source, moduleKind)) {
        queue.push({ importer, importerFile, resolveFrom, relativeViaVite, stylesheet, specifier });
      }
    } catch (error) {
      if (!(error instanceof ImportScanError)) throw error;
      throw prepareFailure(
        importerFile,
        "scan",
        `${error.reason}; importer ${JSON.stringify(importer)}`,
      );
    }
  };

  for (const project of projectSources) {
    enqueueImports(
      project.id,
      project.file,
      path.dirname(project.file),
      false,
      extensionOf(project.file) === ".css",
      project.source,
    );
  }

  for (const specifier of configImports) {
    queue.push({
      importer: ANY_PROJECT_IMPORTER,
      importerFile: path.join(root, "astro.config"),
      resolveFrom: root,
      relativeViaVite: false,
      stylesheet: false,
      specifier,
    });
  }

  const serverExpanded = new Set<ModuleId>();
  const addPhysicalModule = async (file: string): Promise<ModuleId> => {
    const module = await carried.add(file);
    if (!serverExpanded.has(module.id)) {
      serverExpanded.add(module.id);
      const canonical = await canonicalFile(file);
      enqueueImports(module.id, canonical, path.dirname(canonical), false, module.kind === "css", module.source);
    }
    return module.id;
  };

  while (queue.length > 0) {
    const request = queue.shift();
    if (!request) continue;
    let importerRequests = seenRequests.get(request.importer);
    if (!importerRequests) {
      importerRequests = new Set<string>();
      seenRequests.set(request.importer, importerRequests);
    }
    if (importerRequests.has(request.specifier)) continue;
    importerRequests.add(request.specifier);

    const kind = classifySpecifier(request.specifier);
    if (kind === "unsupported") {
      throw prepareFailure(
        request.importerFile,
        "import",
        `imports ${JSON.stringify(request.specifier)}, which the Workers host cannot provide`,
      );
    }
    if (kind === "builtin") {
      throw prepareFailure(
        request.importerFile,
        "import",
        `imports ${JSON.stringify(request.specifier)}, which is not a supported Workers host external`,
      );
    }
    if (kind === "host") {
      resolutions.push({
        importer: request.importer,
        specifier: request.specifier,
        target: { kind: "external", specifier: request.specifier },
      });
      continue;
    }
    if (kind === "virtual" || (kind === "relative" && request.relativeViaVite)) {
      const frozen = await freezeVirtual(request.specifier, request.importerFile);
      if (!frozen) {
        throw prepareFailure(
          request.importerFile,
          "vite.load",
          `could not resolve and load ${kind === "virtual" ? "virtual module" : "relative import from a non-file virtual module"} ` +
            JSON.stringify(request.specifier),
        );
      }
      const moduleKind = kindForFrozenId(frozen.id);
      const frozenIdentity = await logicalFrozenIdentity(root, frozen.id, moduleKind);
      const digest = digestText(
        `${frozenIdentity.logicalId}\0${moduleKind}\0${frozen.code}`,
      ).slice(0, 32);
      const id = `virtual:${digest}`;
      if (!modules.has(id)) {
        modules.set(id, {
          id,
          kind: moduleKind,
          source: frozen.code,
          compilePath: frozenIdentity.compilePath,
        });
        const resolveFrom = frozenIdentity.physicalFile
          ? path.dirname(frozenIdentity.physicalFile)
          : root;
        enqueueImports(
          id,
          frozen.id,
          resolveFrom,
          frozenIdentity.physicalFile === null,
          moduleKind === "css",
          frozen.code,
          moduleKind,
        );
      }
      resolutions.push({
        importer: request.importer,
        specifier: request.specifier,
        target: { kind: "module", id },
      });
      continue;
    }

    let resolved: string;
    try {
      const queryFile = kind === "relative" && request.importer.startsWith("project:") && !request.stylesheet
        ? projectQueryFile(request.specifier)
        : null;
      if (queryFile !== null) {
        const candidate = path.resolve(request.resolveFrom, queryFile);
        const target = await resolveProjectQueryCandidate(candidate);
        if (target === null) throw new Error(`no file matches ${JSON.stringify(candidate)}`);
        resolved = target;
      } else {
        resolved = await resolveWorkerSpecifier(
          request.specifier,
          request.resolveFrom,
          request.stylesheet,
        );
      }
    } catch (error) {
      if (error instanceof PrepareError) throw error;
      throw prepareFailure(
        request.importerFile,
        "resolve",
        `could not resolve ${JSON.stringify(request.specifier)}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
    if (request.stylesheet && kindForFile(resolved) !== "css") {
      throw prepareFailure(
        request.importerFile,
        "resolve",
        `CSS @import ${JSON.stringify(request.specifier)} resolved to a non-CSS module`,
      );
    }

    // Project-relative imports remain owned by the caller's source map. Relative
    // imports inside carried npm/virtual modules must be closed into the artifact.
    if (kind === "relative" && request.importer.startsWith("project:")) continue;
    const id = await addPhysicalModule(resolved);
    resolutions.push({
      importer: request.importer,
      specifier: request.specifier,
      target: { kind: "module", id },
    });
  }

  const browserResolutions = await prepareBrowserGraph(root, projectSources, carried);
  // Discovery order; serializePreparedSite owns the canonical order.
  return {
    modules: [...modules.values()],
    resolutions: withoutDuplicates([...resolutions, ...anyProjectResolutions(resolutions)]),
    browserResolutions,
  };
}

/**
 * One `ANY_PROJECT_IMPORTER` entry per bare specifier every project importer resolves
 * alike, so a page written after prepare finds a package another page already reached.
 */
function anyProjectResolutions(resolutions: readonly ArtifactResolution[]): ArtifactResolution[] {
  const bySpecifier = new Map<string, ArtifactResolutionTarget | null>();
  for (const resolution of resolutions) {
    if (!resolution.importer.startsWith("project:")) continue;
    if (classifySpecifier(resolution.specifier) === "relative") continue;
    const known = bySpecifier.get(resolution.specifier);
    if (known === undefined) {
      bySpecifier.set(resolution.specifier, resolution.target);
    } else if (known !== null && !sameTarget(known, resolution.target)) {
      bySpecifier.set(resolution.specifier, null);
    }
  }
  const shared: ArtifactResolution[] = [];
  for (const [specifier, target] of bySpecifier) {
    if (target !== null) shared.push({ importer: ANY_PROJECT_IMPORTER, specifier, target });
  }
  return shared;
}

/** A config import and a project file can both produce the same project-wide answer. */
function withoutDuplicates(resolutions: readonly ArtifactResolution[]): ArtifactResolution[] {
  const byKey = new Map<string, ArtifactResolution>();
  for (const resolution of resolutions) {
    const key = `${resolution.importer}\0${resolution.specifier}`;
    const known = byKey.get(key);
    if (known !== undefined && !sameTarget(known.target, resolution.target)) {
      throw prepareFailure(
        resolution.importer,
        "resolve",
        `${JSON.stringify(resolution.specifier)} resolves to two different targets`,
      );
    }
    byKey.set(key, resolution);
  }
  return [...byKey.values()];
}

function sameTarget(left: ArtifactResolutionTarget, right: ArtifactResolutionTarget): boolean {
  if (left.kind === "module") return right.kind === "module" && left.id === right.id;
  return right.kind === "external" && left.specifier === right.specifier;
}

interface BrowserRequest {
  /** A project file, or the carried module the import is written in. */
  importer: ModuleId;
  importerFile: string;
  specifier: string;
}

/**
 * The browser graph: every import a processed `<script>` makes, closed with browser
 * export conditions. Project files stay the consumer's; only packages are carried.
 */
async function prepareBrowserGraph(
  root: string,
  projectSources: readonly ProjectImportSource[],
  carried: CarriedModules,
): Promise<ArtifactResolution[]> {
  const resolutions = new Map<string, ArtifactResolution>();
  const queue: BrowserRequest[] = [];
  const expanded = new Set<string>();

  const enqueue = (importer: ModuleId, importerFile: string, source: string, kind: ArtifactModuleKind): void => {
    let specifiers: string[];
    try {
      specifiers = specifiersOf(importerFile, source, kind);
    } catch (error) {
      if (!(error instanceof ImportScanError)) throw error;
      throw prepareFailure(importerFile, "scan", `${error.reason}; browser importer ${JSON.stringify(importer)}`);
    }
    for (const specifier of specifiers) queue.push({ importer, importerFile, specifier });
  };

  for (const project of projectSources) {
    for (const script of project.scripts ?? []) enqueue(project.id, project.file, script, "ts");
  }

  while (queue.length > 0) {
    const request = queue.shift();
    if (!request) continue;
    const kind = classifySpecifier(request.specifier);
    if (kind !== "relative" && kind !== "vendor") {
      throw prepareFailure(
        request.importerFile,
        "browser import",
        `a <script> reaches ${JSON.stringify(request.specifier)}, which only exists on the server`,
      );
    }
    const fromProject = request.importer.startsWith("project:");
    let resolved: string;
    try {
      resolved = await resolveWorkerSpecifier(
        request.specifier,
        path.dirname(request.importerFile),
        false,
        BROWSER_EXPORT_CONDITIONS,
      );
    } catch (error) {
      if (error instanceof PrepareError) throw error;
      throw prepareFailure(
        request.importerFile,
        "browser resolve",
        `could not resolve ${JSON.stringify(request.specifier)}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
    const moduleKind = kindForFile(resolved);
    if (moduleKind !== "js" && moduleKind !== "ts" && moduleKind !== "json" && moduleKind !== "css") {
      throw prepareFailure(
        request.importerFile,
        "browser import",
        `${JSON.stringify(request.specifier)} is a .${moduleKind} module, which a browser script cannot import`,
      );
    }

    if (kind === "relative" && fromProject) {
      const projectRelative = normalizePath(path.relative(root, await canonicalFile(resolved)));
      if (!isInsideRoot(projectRelative)) {
        throw prepareFailure(request.importerFile, "browser import", `${JSON.stringify(request.specifier)} leaves the project`);
      }
      // A project file: the consumer serves it, but its own imports are part of the graph.
      const file = await canonicalFile(resolved);
      if (moduleKind !== "css" && !expanded.has(file)) {
        expanded.add(file);
        enqueue(`project:${projectRelative}`, file, await Bun.file(file).text(), moduleKind);
      }
      continue;
    }

    const module = await carried.add(resolved);
    const importer = fromProject ? ANY_PROJECT_IMPORTER : request.importer;
    const key = `${importer}\0${request.specifier}`;
    const known = resolutions.get(key);
    if (known !== undefined && !sameTarget(known.target, { kind: "module", id: module.id })) {
      throw prepareFailure(
        request.importerFile,
        "browser resolve",
        `${JSON.stringify(request.specifier)} resolves to two different files from two project files`,
      );
    }
    resolutions.set(key, { importer, specifier: request.specifier, target: { kind: "module", id: module.id } });
    if (!expanded.has(module.id)) {
      expanded.add(module.id);
      if (module.kind !== "css") enqueue(module.id, await canonicalFile(resolved), module.source, module.kind);
    }
  }
  return [...resolutions.values()];
}

/** Carried npm files, keyed by their package-local identity. Shared by both graphs. */
class CarriedModules {
  readonly modules = new Map<ModuleId, ArtifactModule>();
  readonly #physicalIds = new Map<string, ModuleId>();
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  async add(file: string): Promise<ArtifactModule> {
    const root = this.#root;
    const canonical = await canonicalFile(file);
    const known = this.#physicalIds.get(canonical);
    const knownModule = known === undefined ? undefined : this.modules.get(known);
    if (knownModule) return knownModule;

    const id = await npmModuleId(root, canonical, "resolve");
    const existing = this.modules.get(id);
    if (existing) {
      if (existing.compilePath !== compilePathFor(root, canonical)) {
        throw prepareFailure(id, "identity", "two resolved files produced the same module id");
      }
      this.#physicalIds.set(canonical, id);
      return existing;
    }

    const kind = kindForFile(canonical);
    let source: string;
    try {
      source = await Bun.file(canonical).text();
    } catch (error) {
      throw prepareFailure(
        displayPath(root, canonical),
        "load",
        error instanceof Error ? error.message : String(error),
      );
    }
    const module: ArtifactModule = { id, kind, source, compilePath: compilePathFor(root, canonical) };
    this.modules.set(id, module);
    this.#physicalIds.set(canonical, id);
    return module;
  }
}

function projectQueryFile(specifier: string): string | null {
  const mark = specifier.indexOf("?");
  if (mark === -1) return null;
  const query = specifier.slice(mark + 1);
  // Match the Workers consumer's raw/inline/url query keys; the source map owns their output.
  return /(^|&)(raw|inline|url)(&|=|$)/.test(query) ? specifier.slice(0, mark) : null;
}

// Query targets follow Workers resolveInFiles, not npm/package.json resolution.
async function resolveProjectQueryCandidate(candidate: string): Promise<string | null> {
  if (await isFile(candidate)) return candidate;
  const extension = extensionOf(candidate);
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") {
    const stem = candidate.slice(0, -extension.length);
    for (const suffix of [".ts", ".tsx", ".mts", ".cts"]) {
      if (await isFile(stem + suffix)) return stem + suffix;
    }
  }
  if (extension === "") {
    const implied = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".astro", ".mts", ".cts"];
    for (const suffix of implied) {
      if (await isFile(candidate + suffix)) return candidate + suffix;
    }
    for (const suffix of implied) {
      const index = path.join(candidate, `index${suffix}`);
      if (await isFile(index)) return index;
    }
  }
  return null;
}

function kindForExtension(extension: string): ArtifactModuleKind | null {
  if (extension === ".js" || extension === ".mjs") return "js";
  if (extension === ".ts" || extension === ".mts") return "ts";
  if (extension === ".jsx") return "jsx";
  if (extension === ".tsx") return "tsx";
  if (extension === ".json") return "json";
  if (extension === ".astro") return "astro";
  if (extension === ".css") return "css";
  return null;
}

function kindForFile(file: string): ArtifactModuleKind {
  const extension = extensionOf(file);
  const kind = kindForExtension(extension);
  if (kind !== null) return kind;
  if (extension === ".cjs" || extension === ".cts") {
    throw prepareFailure(
      file,
      "loader",
      `CommonJS ${extension} modules cannot run in the Workers module graph`,
    );
  }
  throw prepareFailure(file, "loader", `unsupported module extension ${JSON.stringify(extension)}`);
}

/** A Vite id without an extension (`virtual:x`) is TypeScript, as the Bun host loads it. */
function kindForFrozenId(id: string): ArtifactModuleKind {
  const extension = path.extname(id.replaceAll("\0", "")).toLowerCase();
  if (extension === "") return "ts";
  const kind = kindForExtension(extension);
  if (kind !== null) return kind;
  throw prepareFailure(id, "vite.load", `unsupported module extension ${JSON.stringify(extension)}`);
}

interface FrozenIdentity {
  logicalId: string;
  compilePath: string;
  physicalFile: string | null;
}

async function logicalFrozenIdentity(
  root: string,
  id: string,
  kind: ArtifactModuleKind,
): Promise<FrozenIdentity> {
  if (!path.isAbsolute(id)) {
    return {
      logicalId: id,
      compilePath: virtualCompilePath(id, kind),
      physicalFile: null,
    };
  }
  const canonical = await canonicalFile(id);
  const projectRelative = normalizePath(path.relative(root, canonical));
  return {
    logicalId: isInsideRoot(projectRelative)
      ? `project:${projectRelative}`
      : await npmModuleId(root, canonical, "vite.resolveId"),
    compilePath: compilePathFor(root, canonical),
    physicalFile: canonical,
  };
}

/** `npm:<package digest>/<package-relative path>` for a file outside the project. */
async function npmModuleId(root: string, canonical: string, hook: string): Promise<ModuleId> {
  const packageIdentity = await packageIdentityFor(canonical);
  if (!packageIdentity) {
    throw prepareFailure(
      displayPath(root, canonical),
      hook,
      "resolved outside the project without an owning package.json",
    );
  }
  const packageRelative = normalizePath(path.relative(packageIdentity.root, canonical));
  if (packageRelative === "" || !isInsideRoot(packageRelative)) {
    throw prepareFailure(
      displayPath(root, canonical),
      hook,
      "could not derive a package-relative module identity",
    );
  }
  return `npm:${packageIdentity.digest}/${packageRelative}`;
}

async function resolveWorkerSpecifier(
  specifier: string,
  resolveFrom: string,
  stylesheet: boolean,
  scriptConditions: readonly string[] = WORKER_EXPORT_CONDITIONS,
): Promise<string> {
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    const candidate = specifier.startsWith("/")
      ? specifier
      : path.resolve(resolveFrom, specifier);
    const resolved = await resolveFileCandidate(candidate);
    if (resolved) return resolved;
    throw new Error(`no file matches ${JSON.stringify(candidate)}`);
  }

  const parsed = parsePackageSpecifier(specifier);
  const packageRecord = await findPackage(resolveFrom, parsed.name);
  if (!packageRecord) {
    throw new Error(`package ${JSON.stringify(parsed.name)} was not found from ${JSON.stringify(resolveFrom)}`);
  }
  const conditions = stylesheet ? STYLESHEET_EXPORT_CONDITIONS : scriptConditions;
  const target = resolvePackageEntry(packageRecord.manifest, parsed.subpath, conditions);
  if (!target) {
    throw new Error(
      `package ${JSON.stringify(parsed.name)} does not export ${JSON.stringify(parsed.subpath)} ` +
        `for conditions ${conditions.join(", ")}`,
    );
  }
  if (!target.startsWith("./")) {
    throw new Error(`package export target ${JSON.stringify(target)} is not package-relative`);
  }
  const candidate = path.resolve(packageRecord.root, target);
  const relative = normalizePath(path.relative(packageRecord.root, candidate));
  if (!isInsideRoot(relative)) {
    throw new Error(`package export target ${JSON.stringify(target)} escapes its package root`);
  }
  const resolved = await resolveFileCandidate(candidate);
  if (resolved) return resolved;
  throw new Error(`package export target ${JSON.stringify(target)} does not resolve to a supported file`);
}

interface ParsedPackageSpecifier {
  name: string;
  subpath: string;
}

function parsePackageSpecifier(specifier: string): ParsedPackageSpecifier {
  const segments = specifier.split("/");
  const packageSegments = specifier.startsWith("@") ? segments.slice(0, 2) : segments.slice(0, 1);
  const name = packageSegments.join("/");
  const rest = segments.slice(packageSegments.length).join("/");
  return { name, subpath: rest ? `./${rest}` : "." };
}

async function findPackage(resolveFrom: string, name: string): Promise<PackageRecord | null> {
  let directory = path.resolve(resolveFrom);
  while (true) {
    const packageRoot = path.join(directory, "node_modules", name);
    const manifestPath = path.join(packageRoot, "package.json");
    try {
      const source = await fs.readFile(manifestPath, "utf8");
      const manifest: unknown = JSON.parse(source);
      return { root: await canonicalFile(packageRoot), manifest };
    } catch (error) {
      if (!isMissingFile(error)) {
        throw prepareFailure(
          manifestPath,
          "package.json",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function resolvePackageEntry(
  manifest: unknown,
  subpath: string,
  conditions: readonly string[] = WORKER_EXPORT_CONDITIONS,
): string | null {
  const exportsValue = objectProperty(manifest, "exports");
  if (exportsValue !== undefined) {
    return resolveExportsValue(exportsValue, subpath, null, conditions);
  }
  if (subpath !== ".") return subpath;
  for (const field of ["browser", "module", "main"]) {
    const value = objectProperty(manifest, field);
    if (typeof value === "string" && value.trim()) {
      return value.startsWith("./") ? value : `./${value}`;
    }
  }
  return "./index.js";
}

function resolveExportsValue(
  value: unknown,
  subpath: string,
  replacement: string | null,
  conditions: readonly string[],
): string | null {
  if (typeof value === "string") {
    if (subpath !== "." && replacement === null) return null;
    return replacement === null ? value : value.replaceAll("*", replacement);
  }
  if (Array.isArray(value)) {
    for (const candidate of value) {
      const resolved = resolveExportsValue(candidate, subpath, replacement, conditions);
      if (resolved) return resolved;
    }
    return null;
  }
  if (typeof value !== "object" || value === null) return null;

  const keys = Object.keys(value);
  const subpathKeys = keys.filter((key) => key.startsWith("."));
  if (subpathKeys.length > 0) {
    const exact = objectProperty(value, subpath);
    if (exact !== undefined) return resolveExportsValue(exact, ".", null, conditions);
    const patterns = subpathKeys
      .filter((key) => key.includes("*"))
      .sort((left, right) => right.length - left.length || compareStrings(left, right));
    for (const pattern of patterns) {
      const star = pattern.indexOf("*");
      const prefix = pattern.slice(0, star);
      const suffix = pattern.slice(star + 1);
      if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
      const matched = subpath.slice(prefix.length, subpath.length - suffix.length);
      const target = objectProperty(value, pattern);
      const resolved = resolveExportsValue(target, ".", matched, conditions);
      if (resolved) return resolved;
    }
    return null;
  }
  if (subpath !== ".") return null;
  for (const condition of conditions) {
    const candidate = objectProperty(value, condition);
    if (candidate === undefined) continue;
    const resolved = resolveExportsValue(candidate, ".", replacement, conditions);
    if (resolved) return resolved;
  }
  return null;
}

function objectProperty(value: unknown, property: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return Reflect.get(value, property);
}

async function resolveFileCandidate(candidate: string): Promise<string | null> {
  const extension = extensionOf(candidate);
  const candidates = [candidate];
  if (extension === ".js") {
    const stem = candidate.slice(0, -extension.length);
    candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.jsx`, `${stem}.mts`);
  } else if (extension === "") {
    for (const suffix of [".js", ".mjs", ".ts", ".mts", ".jsx", ".tsx", ".json", ".astro", ".css", ".cjs", ".cts"]) {
      candidates.push(`${candidate}${suffix}`);
    }
  }
  for (const file of candidates) {
    if (await isFile(file)) return file;
  }
  if (extension === "" && await isDirectory(candidate)) {
    const manifestPath = path.join(candidate, "package.json");
    try {
      const source = await fs.readFile(manifestPath, "utf8");
      const manifest: unknown = JSON.parse(source);
      const entry = resolvePackageEntry(manifest, ".");
      if (entry?.startsWith("./")) {
        const nested = await resolveFileCandidate(path.resolve(candidate, entry));
        if (nested) return nested;
      }
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    for (const suffix of [".js", ".mjs", ".ts", ".mts", ".jsx", ".tsx", ".json", ".astro", ".css", ".cjs", ".cts"]) {
      const index = path.join(candidate, `index${suffix}`);
      if (await isFile(index)) return index;
    }
  }
  return null;
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isFile();
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

async function isDirectory(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isDirectory();
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

async function canonicalFile(file: string): Promise<string> {
  try {
    return await fs.realpath(file);
  } catch {
    return path.resolve(file);
  }
}

async function packageIdentityFor(file: string): Promise<PackageIdentity | null> {
  let directory = path.dirname(file);
  while (true) {
    const manifestPath = path.join(directory, "package.json");
    try {
      const manifest = await fs.readFile(manifestPath, "utf8");
      const logicalInstance = packageInstancePath(directory);
      return {
        root: directory,
        digest: digestText(`${logicalInstance}\0${manifest}`).slice(0, 20),
      };
    } catch (error) {
      if (!isMissingFile(error)) {
        throw prepareFailure(manifestPath, "package.json", String(error));
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function packageInstancePath(directory: string): string {
  const normalized = normalizePath(directory);
  const marker = "/node_modules/";
  const first = normalized.indexOf(marker);
  return first === -1 ? path.posix.basename(normalized) : normalized.slice(first + 1);
}

function compilePathFor(root: string, file: string): string {
  return normalizePath(path.relative(root, file));
}

function virtualCompilePath(id: string, kind: ArtifactModuleKind): string {
  const clean = id.replaceAll("\0", "");
  if (clean.trim()) return clean;
  return `virtual-module.${extensionForKind(kind)}`;
}

function extensionForKind(kind: ArtifactModuleKind): string {
  return kind === "astro" ? "astro" : kind;
}

function displayPath(root: string, file: string): string {
  return normalizePath(path.relative(root, file)) || normalizePath(file);
}

function digestText(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}
