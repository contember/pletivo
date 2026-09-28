import type { ModuleId } from "@pletivo/core/artifact";
import {
  executionNameForModuleId,
  ModuleIdentityCollisionError,
  projectModuleId,
  type ArtifactResolver,
} from "../artifact.ts";
import { ASSETS_SOURCES } from "../astro-assets.ts";
import { ENV_MODULES } from "../env.ts";
import { RUNTIME_MODULES } from "../generated/runtime-modules.ts";
import type { ResolvedModule, ResolvedModuleEdge } from "../module-graph.ts";
import type { ProjectFiles } from "../project-store.ts";
import type { TailwindStylesheets } from "../tailwind.ts";
import { projectModuleKind } from "./module-kind.ts";
import { CompileSources, NormalizedProjectFiles } from "./project-files.ts";
import { resolveInFiles } from "./resolve-in-files.ts";
import {
  UnsupportedFileError,
  type ModuleDescriptor,
  type SourceModule,
} from "./source-module.ts";
import type { AstroStyles } from "./types.ts";

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
 * Everything one `compileProject` call accumulates while it walks the import graph.
 *
 * The project file map is private: every read of a project file's contents goes through
 * `readProjectFile`, and every existence check through `resolveProjectFile`,
 * `projectPaths` or the content-config probe.
 */
export class CompileWalk {
  /** The caller's files plus the artifact's sources; what `CompiledProject.sources` returns. */
  readonly sources: CompileSources;
  /** URL path -> the file's text, for every `?url` import the project made. */
  readonly urlAssets = new Map<string, string>();
  readonly modules: Record<string, string> = { ...RUNTIME_MODULES };
  readonly moduleNames = new Map<string, string>();
  readonly styles = new Map<string, AstroStyles>();
  readonly imports = new Map<string, string[]>();
  readonly cssImports = new Map<string, string[]>();
  readonly graphModules: ResolvedModule[] = [];
  readonly graphEdges: ResolvedModuleEdge[] = [];
  usesImportMetaEnv = false;

  readonly #projectFiles: NormalizedProjectFiles;
  readonly #artifact: ArtifactResolver;
  readonly #srcDir: string | undefined;
  readonly #takenNames = new Map<string, ModuleId>();
  readonly #claimed = new Map<ModuleId, SourceModule>();
  /** Named and not yet compiled. Appended to *while* it is walked; see `pending`. */
  readonly #queue: SourceModule[] = [];
  /** Names taken from `astro:env/client` and `astro:env/server`, across the whole walk. */
  readonly #envNames = new Map<string, Set<string>>(
    [...ENV_MODULES.keys()].map((specifier) => [specifier, new Set<string>()]),
  );
  readonly #usedEnv = new Set<string>();
  #usesContent = false;
  /** The content config, seeded the moment something reaches for the content API. */
  #contentConfig: string | null = null;
  #usesImages = false;

  constructor(files: ProjectFiles, artifact: ArtifactResolver, srcDir: string | undefined) {
    this.#projectFiles = new NormalizedProjectFiles(files);
    this.#artifact = artifact;
    this.#srcDir = srcDir;
    this.sources = new CompileSources(this.#projectFiles, artifact);
  }

  get usesContent(): boolean {
    return this.#usesContent;
  }

  get contentConfig(): string | null {
    return this.#contentConfig;
  }

  get usesImages(): boolean {
    return this.#usesImages;
  }

  get usedEnv(): ReadonlySet<string> {
    return this.#usedEnv;
  }

  get envNames(): ReadonlyMap<string, ReadonlySet<string>> {
    return this.#envNames;
  }

  /** The legacy key a claimed module was named under, or `undefined` if it was never claimed. */
  claimedLegacyKey(id: ModuleId): string | undefined {
    return this.#claimed.get(id)?.legacyKey;
  }

  /**
   * Every module claimed for compiling, in claim order. Claiming while this is iterated
   * appends to it, so it is walked with an index cursor rather than `shift()`.
   */
  *pending(): Generator<SourceModule> {
    for (let index = 0; index < this.#queue.length; index++) yield this.#queue[index];
  }

  /** The one place a project file's contents are read. */
  readProjectFile(file: string): string | undefined {
    return this.#projectFiles.get(file);
  }

  /** The project file a resolved specifier names, or `null`. See `resolveInFiles`. */
  resolveProjectFile(resolved: string): string | null {
    return resolveInFiles(resolved, this.#projectFiles);
  }

  /** Every project path, as a snapshot: the walk can add the `astro:assets` sources. */
  projectPaths(): string[] {
    return [...this.#projectFiles.keys()];
  }

  /**
   * The module a project file becomes, claimed on first sight — which is also how the
   * file joins the walk. `null` for anything the bundle cannot hold as a module.
   */
  projectModule(file: string): SourceModule | null {
    const source = this.readProjectFile(file);
    const kind = projectModuleKind(file);
    if (source === undefined || kind === null) return null;
    return this.#claim({
      id: projectModuleId(file),
      legacyKey: file,
      kind,
      source,
      compilePath: file,
      origin: "project",
    });
  }

  artifactModule(id: ModuleId): SourceModule {
    const module = this.#artifact.module(id);
    if (module === null) {
      throw new UnsupportedFileError(id, "the validated artifact target is missing");
    }
    return this.#claim({
      id: module.id,
      legacyKey: module.id,
      kind: module.kind,
      source: module.source,
      compilePath: module.compilePath ?? module.id,
      origin: "artifact",
    });
  }

  hostStylesheet(specifier: keyof TailwindStylesheets, source: string): SourceModule {
    const id = `host:${specifier}`;
    this.sources.addGenerated(id, source);
    return this.#claim({
      id,
      legacyKey: id,
      kind: "css",
      source,
      compilePath: id,
      origin: "generated",
    });
  }

  /** A module whose code is final when it is claimed, so it never joins the queue. */
  generatedModule(id: ModuleId, legacyKey: string, code: string): SourceModule {
    const known = this.#claimed.get(id);
    const descriptor: ModuleDescriptor = {
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
      this.moduleNames.set(legacyKey, known.executionName);
      return known;
    }
    const executionName = this.#claimBundleName(id);
    const module: SourceModule = { ...descriptor, executionName };
    this.#claimed.set(id, module);
    this.moduleNames.set(legacyKey, executionName);
    this.modules[executionName] = code;
    this.graphModules.push({
      identity: { id, compilePath: id, executionName },
      kind: "js",
      source: code,
    });
    return module;
  }

  /** Add the `astro:assets` implementation to the project, the first time it is reached. */
  addAssetSources(): void {
    for (const [file, source] of Object.entries(ASSETS_SOURCES)) this.#projectFiles.add(file, source);
  }

  /**
   * Mark the content API as used and seed the content config into the walk: nothing
   * imports it, so a pruned walk would never reach it otherwise.
   */
  useContent(): void {
    if (this.#usesContent) return;
    this.#usesContent = true;
    this.#contentConfig = this.#findContentConfig();
    if (this.#contentConfig !== null) this.projectModule(this.#contentConfig);
  }

  markImagesUsed(): void {
    this.#usesImages = true;
  }

  /** Record an `astro:env` module as used, with the names one importer takes from it. */
  useEnv(specifier: string, names: readonly string[]): void {
    this.#usedEnv.add(specifier);
    const into = this.#envNames.get(specifier);
    if (into !== undefined) for (const name of names) into.add(name);
  }

  /**
   * Naming lazily is what makes a forward reference work: `rewriteImports` runs while
   * compiling A and has to emit `./<name-of-B>` before B has been read, and the name
   * is a pure function of B's path, so it can be claimed without reading it.
   */
  #claim(descriptor: ModuleDescriptor): SourceModule {
    const known = this.#claimed.get(descriptor.id);
    if (known !== undefined) {
      if (!sameDescriptor(descriptor, known)) {
        throw new ModuleIdentityCollisionError(descriptor.id, "the claimed module descriptors differ");
      }
      this.moduleNames.set(descriptor.legacyKey, known.executionName);
      return known;
    }
    const executionName = this.#claimBundleName(descriptor.id);
    const sourceModule: SourceModule = { ...descriptor, executionName };
    this.#claimed.set(descriptor.id, sourceModule);
    this.moduleNames.set(descriptor.legacyKey, executionName);
    this.graphModules.push({
      identity: {
        id: descriptor.id,
        compilePath: descriptor.compilePath,
        executionName,
      },
      kind: descriptor.kind,
      source: descriptor.source,
    });
    this.#queue.push(sourceModule);
    return sourceModule;
  }

  /**
   * The name a module takes in the bundle, with the collision it cannot rule out turned
   * into an error.
   *
   * A pure function of the id, deliberately: a compile pruned to one page's graph reaches
   * files in an order of its own, and a name that moved with discovery order would give
   * one program two bundles. The hash makes a collision unlikely, not impossible, and an
   * unnoticed one would silently overwrite a module in the bundle.
   */
  #claimBundleName(id: ModuleId): string {
    const name = executionNameForModuleId(id);
    const other = this.#takenNames.get(name);
    if (other !== undefined && other !== id) {
      throw new Error(
        `[pletivo-workers] ${JSON.stringify(id)} and ${JSON.stringify(other)} both compile to ` +
          `the bundle name ${JSON.stringify(name)}`,
      );
    }
    this.#takenNames.set(name, id);
    return name;
  }

  /**
   * The project's content config, or `null`.
   *
   * Probed by path when the caller said where the source tree starts. Without a `srcDir`
   * there is no root to resolve against, so each candidate is matched as a suffix over
   * every key instead.
   */
  #findContentConfig(): string | null {
    const srcDir = this.#srcDir;
    if (srcDir !== undefined) {
      const prefix = srcDir === "" ? "" : `${srcDir}/`;
      for (const candidate of CONTENT_CONFIG_CANDIDATES) {
        if (this.#projectFiles.has(prefix + candidate)) return prefix + candidate;
      }
      return null;
    }
    for (const candidate of CONTENT_CONFIG_CANDIDATES) {
      const suffix = `${DEFAULT_SRC_DIR}/${candidate}`;
      for (const file of this.#projectFiles.keys()) {
        if (file === suffix || file.endsWith(`/${suffix}`)) return file;
      }
    }
    return null;
  }
}

function sameDescriptor(left: ModuleDescriptor, right: SourceModule): boolean {
  return (
    left.kind === right.kind &&
    left.source === right.source &&
    left.compilePath === right.compilePath &&
    left.origin === right.origin
  );
}
