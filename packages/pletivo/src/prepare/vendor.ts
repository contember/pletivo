/** Close every non-project import into Artifact V2 modules and resolutions. */

import fs from "node:fs/promises";
import path from "node:path";
import type {
  ArtifactModule,
  ArtifactModuleKind,
  ArtifactResolution,
  ModuleId,
} from "@pletivo/core/artifact";
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
}

export interface FrozenVirtualSource {
  id: string;
  code: string;
  loader: string;
}

export type FreezeVirtualSource = (
  specifier: string,
  importer: string,
) => Promise<FrozenVirtualSource | null>;

export interface PreparedGraph {
  modules: ArtifactModule[];
  resolutions: ArtifactResolution[];
}

export class PrepareGraphError extends Error {
  constructor(
    readonly source: string,
    readonly hook: string,
    readonly reason: string,
  ) {
    super(`${source} (${hook}): ${reason}`);
    this.name = "PrepareGraphError";
  }
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

/** Build the artifact-owned part of the project graph. */
export async function prepareModuleGraph(
  root: string,
  projectSources: readonly ProjectImportSource[],
  freezeVirtual: FreezeVirtualSource,
  pathPrefix = "",
): Promise<PreparedGraph> {
  const modules = new Map<ModuleId, ArtifactModule>();
  const resolutions: ArtifactResolution[] = [];
  const queue: ImportRequest[] = [];
  const seenRequests = new Map<ModuleId, Set<string>>();
  const physicalIds = new Map<string, ModuleId>();

  const enqueueImports = (
    importer: ModuleId,
    importerFile: string,
    resolveFrom: string,
    relativeViaVite: boolean,
    stylesheet: boolean,
    source: string,
  ): void => {
    try {
      for (const specifier of specifiersOf(importerFile, source)) {
        queue.push({ importer, importerFile, resolveFrom, relativeViaVite, stylesheet, specifier });
      }
    } catch (error) {
      if (!(error instanceof ImportScanError)) throw error;
      throw new PrepareGraphError(
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

  const addPhysicalModule = async (file: string): Promise<ModuleId> => {
    const canonical = await canonicalFile(file);
    const known = physicalIds.get(canonical);
    if (known) return known;

    const packageIdentity = await packageIdentityFor(canonical);
    if (!packageIdentity) {
      throw new PrepareGraphError(
        displayPath(root, canonical),
        "resolve",
        "resolved outside the project without an owning package.json",
      );
    }
    const packageRelative = normalizePath(path.relative(packageIdentity.root, canonical));
    if (packageRelative === "" || packageRelative.startsWith("../")) {
      throw new PrepareGraphError(
        displayPath(root, canonical),
        "resolve",
        "could not derive a package-relative module identity",
      );
    }
    const id = `npm:${packageIdentity.digest}/${packageRelative}`;
    const existing = modules.get(id);
    if (existing) {
      if (existing.compilePath !== compilePathFor(root, canonical, pathPrefix)) {
        throw new PrepareGraphError(id, "identity", "two resolved files produced the same module id");
      }
      physicalIds.set(canonical, id);
      return id;
    }

    const kind = kindForFile(canonical);
    let source: string;
    try {
      source = await Bun.file(canonical).text();
    } catch (error) {
      throw new PrepareGraphError(
        displayPath(root, canonical),
        "load",
        error instanceof Error ? error.message : String(error),
      );
    }
    modules.set(id, {
      id,
      kind,
      source,
      compilePath: compilePathFor(root, canonical, pathPrefix),
    });
    physicalIds.set(canonical, id);
    enqueueImports(id, canonical, path.dirname(canonical), false, kind === "css", source);
    return id;
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
      throw new PrepareGraphError(
        request.importerFile,
        "import",
        `imports ${JSON.stringify(request.specifier)}, which the Workers host cannot provide`,
      );
    }
    if (kind === "builtin") {
      throw new PrepareGraphError(
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
        throw new PrepareGraphError(
          request.importerFile,
          "vite.load",
          `could not resolve and load ${kind === "virtual" ? "virtual module" : "relative import from a non-file virtual module"} ` +
            JSON.stringify(request.specifier),
        );
      }
      const moduleKind = kindForLoader(frozen.loader, frozen.id);
      const frozenIdentity = await logicalFrozenIdentity(root, frozen.id, moduleKind, pathPrefix);
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
      resolved = await resolveWorkerSpecifier(
        request.specifier,
        request.resolveFrom,
        request.stylesheet,
      );
    } catch (error) {
      if (error instanceof PrepareGraphError) throw error;
      throw new PrepareGraphError(
        request.importerFile,
        "resolve",
        `could not resolve ${JSON.stringify(request.specifier)}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
    if (request.stylesheet && kindForFile(resolved) !== "css") {
      throw new PrepareGraphError(
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

  return {
    modules: [...modules.values()].sort((left, right) => compareStrings(left.id, right.id)),
    resolutions: resolutions.sort((left, right) => {
      const importerOrder = compareStrings(left.importer, right.importer);
      return importerOrder === 0
        ? compareStrings(left.specifier, right.specifier)
        : importerOrder;
    }),
  };
}

function kindForFile(file: string): ArtifactModuleKind {
  const extension = extensionOf(file);
  if (extension === ".js" || extension === ".mjs") return "js";
  if (extension === ".ts" || extension === ".mts") return "ts";
  if (extension === ".jsx") return "jsx";
  if (extension === ".tsx") return "tsx";
  if (extension === ".json") return "json";
  if (extension === ".astro") return "astro";
  if (extension === ".css") return "css";
  if (extension === ".cjs" || extension === ".cts") {
    throw new PrepareGraphError(
      file,
      "loader",
      `CommonJS ${extension} modules cannot run in the Workers module graph`,
    );
  }
  throw new PrepareGraphError(file, "loader", `unsupported module extension ${JSON.stringify(extension)}`);
}

function kindForLoader(loader: string, id: string): ArtifactModuleKind {
  if (loader === "js") return "js";
  if (loader === "ts") return "ts";
  if (loader === "jsx") return "jsx";
  if (loader === "tsx") return "tsx";
  if (loader === "json") return "json";
  if (loader === "css") return "css";
  if (loader === "astro") return "astro";
  throw new PrepareGraphError(id, "vite.load", `unsupported loader ${JSON.stringify(loader)}`);
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
  pathPrefix: string,
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
  if (isProjectRelative(projectRelative)) {
    return {
      logicalId: `project:${projectRelative}`,
      compilePath: compilePathFor(root, canonical, pathPrefix),
      physicalFile: canonical,
    };
  }
  const packageIdentity = await packageIdentityFor(canonical);
  if (!packageIdentity) {
    throw new PrepareGraphError(
      displayPath(root, canonical),
      "vite.resolveId",
      "absolute Vite id is outside the project and has no owning package.json",
    );
  }
  const packageRelative = normalizePath(path.relative(packageIdentity.root, canonical));
  if (!isProjectRelative(packageRelative) || packageRelative === "") {
    throw new PrepareGraphError(
      displayPath(root, canonical),
      "vite.resolveId",
      "could not derive a package-relative identity for absolute Vite id",
    );
  }
  return {
    logicalId: `npm:${packageIdentity.digest}/${packageRelative}`,
    compilePath: compilePathFor(root, canonical, pathPrefix),
    physicalFile: canonical,
  };
}

async function resolveWorkerSpecifier(
  specifier: string,
  resolveFrom: string,
  stylesheet: boolean,
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
  const conditions = stylesheet ? STYLESHEET_EXPORT_CONDITIONS : WORKER_EXPORT_CONDITIONS;
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
  if (!isProjectRelative(relative)) {
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
        throw new PrepareGraphError(
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

function isProjectRelative(relative: string): boolean {
  return relative !== ".." && !relative.startsWith("../") && !path.isAbsolute(relative);
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
        throw new PrepareGraphError(manifestPath, "package.json", String(error));
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

function isMissingFile(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return Reflect.get(error, "code") === "ENOENT";
}

function compilePathFor(root: string, file: string, pathPrefix: string): string {
  const relative = normalizePath(path.relative(root, file));
  if (!pathPrefix) return relative;
  return path.posix.join(normalizePath(pathPrefix), relative);
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

function normalizePath(value: string): string {
  return value.split(path.sep).join("/");
}

function digestText(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
