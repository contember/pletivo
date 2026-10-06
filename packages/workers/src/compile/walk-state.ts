import type { ModuleId } from "@pletivo/core/artifact";
import { executionNameForModuleId, projectModuleId, type ArtifactResolver } from "../artifact.ts";
import { ASSETS_SOURCES } from "../astro-assets.ts";
import type { OrderedExecutionEdge, OrderedStyleEdge, ProgramContentRequirement } from "../compiled-program.ts";
import { ENV_MODULES } from "../env.ts";
import { RUNTIME_MODULES } from "../generated/runtime-modules.ts";
import type { ProjectFiles } from "../project-store.ts";
import type { TailwindStylesheets } from "../tailwind.ts";
import { projectModuleKind } from "./module-kind.ts";
import { CompileSources, NormalizedProjectFiles } from "./project-files.ts";
import { resolveInFiles } from "./resolve-in-files.ts";
import { UnsupportedFileError, type SourceModule } from "./source-module.ts";
import type { AstroStyles } from "./types.ts";

/** Content config paths relative to `srcDir`, in the Bun host's `initCollections` order. */
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
 * The project file map is private; contents are read only through `readProjectFile`.
 */
export class CompileWalk {
  /** The caller's files plus the artifact's sources; what `CompiledProject.sources` returns. */
  readonly sources: CompileSources;
  /** URL path -> the file's text, for every `?url` import the project made. */
  readonly urlAssets = new Map<string, string>();
  readonly modules: Record<string, string> = { ...RUNTIME_MODULES };
  /** Every claimed module, in claim order. */
  readonly moduleIds: ModuleId[] = [];
  /** Module-to-module edges, one per distinct specifier of an importer, in source order. */
  readonly executionEdges: OrderedExecutionEdge[] = [];
  readonly styleEdges: OrderedStyleEdge[] = [];
  readonly styles = new Map<ModuleId, AstroStyles>();
  /** Names taken from `astro:env/client` and `astro:env/server`, across the whole walk. */
  readonly envNames = new Map<string, Set<string>>(
    [...ENV_MODULES.keys()].map((specifier) => [specifier, new Set<string>()]),
  );
  readonly usedEnv = new Set<string>();
  usesImportMetaEnv = false;
  usesImages = false;

  readonly #projectFiles: NormalizedProjectFiles;
  readonly #artifact: ArtifactResolver;
  readonly #srcDir: string | undefined;
  readonly #takenNames = new Map<string, ModuleId>();
  readonly #claimed = new Map<ModuleId, SourceModule>();
  /** Named and not yet compiled. Appended to *while* it is walked; see `pending`. */
  readonly #queue: SourceModule[] = [];
  /** Set the moment something reaches for the content API, with the config it seeded. */
  #content: ProgramContentRequirement | null = null;

  constructor(files: ProjectFiles, artifact: ArtifactResolver, srcDir: string | undefined) {
    this.#projectFiles = new NormalizedProjectFiles(files);
    this.#artifact = artifact;
    this.#srcDir = srcDir;
    this.sources = new CompileSources(this.#projectFiles, artifact);
  }

  get content(): ProgramContentRequirement | null {
    return this.#content;
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
      kind: "css",
      source,
      compilePath: id,
      origin: "generated",
    });
  }

  /** A module whose code is final when it is claimed, so it never joins the queue. */
  generatedModule(id: ModuleId, code: string): SourceModule {
    const module = this.#claim(
      { id, kind: "js", source: code, compilePath: id, origin: "generated" },
      { queue: false },
    );
    this.modules[module.executionName] = code;
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
    if (this.#content !== null) return;
    const configFile = this.#findContentConfig();
    const config = configFile === null ? null : this.projectModule(configFile);
    this.#content = { configExecutionName: config?.executionName ?? null };
  }

  /** Record an `astro:env` module as used, with the names one importer takes from it. */
  useEnv(specifier: string, names: readonly string[]): void {
    this.usedEnv.add(specifier);
    const into = this.envNames.get(specifier);
    if (into !== undefined) for (const name of names) into.add(name);
  }

  /** A stylesheet target is a style edge; anything else an importer reaches executes. */
  addEdge(importer: SourceModule, target: SourceModule): void {
    const edge = { importer: importer.id, target: target.id };
    if (target.kind === "css") this.styleEdges.push(edge);
    else this.executionEdges.push(edge);
  }

  /** Names without compiling, so an importer can reference a module not yet compiled. */
  #claim(
    descriptor: Omit<SourceModule, "executionName">,
    { queue }: { queue: boolean } = { queue: true },
  ): SourceModule {
    const known = this.#claimed.get(descriptor.id);
    if (known !== undefined) return known;
    const sourceModule: SourceModule = { ...descriptor, executionName: this.#claimBundleName(descriptor.id) };
    this.#claimed.set(descriptor.id, sourceModule);
    this.moduleIds.push(descriptor.id);
    if (queue) this.#queue.push(sourceModule);
    return sourceModule;
  }

  /**
   * The module's bundle name. Must stay a pure function of the id: pruned walks reach
   * files in different orders. A hash collision throws rather than overwrite a module.
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

  /** The project's content config, or `null`. Without `srcDir`, candidates match as key suffixes. */
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

