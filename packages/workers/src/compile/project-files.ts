import {
  ModuleIdentityCollisionError,
  normalizeProjectPath,
  projectModuleId,
  type ArtifactResolver,
} from "../artifact.ts";
import type { ProjectFiles } from "../project-store.ts";
import { UnsupportedFileError } from "./source-module.ts";

/**
 * The caller's project under normalized keys, plus the sources the walk adds to it.
 *
 * Normalizing reads keys only, and only a key that normalization changes is indexed;
 * a file's contents are read when the walk asks for that file.
 */
export class NormalizedProjectFiles implements ProjectFiles {
  readonly #files: ProjectFiles;
  /** Normalized path -> the caller's key, for the keys normalization changed. */
  readonly #renamed = new Map<string, string>();
  /** Sources the walk added where the project has no file of its own. */
  readonly #added = new Map<string, string>();

  constructor(files: ProjectFiles) {
    this.#files = files;
    for (const key of files.keys()) {
      const path = normalizeProjectPath(key);
      if (path.length === 0) throw new UnsupportedFileError(key, "the normalized path is empty");
      if (path === key) continue;
      const owner = this.#renamed.get(path) ?? (files.has(path) ? path : undefined);
      if (owner !== undefined) {
        throw new ModuleIdentityCollisionError(
          projectModuleId(path),
          `${JSON.stringify(key)} and ${JSON.stringify(owner)} normalize to the same project module`,
        );
      }
      this.#renamed.set(path, key);
    }
  }

  *keys(): Generator<string> {
    for (const key of this.#files.keys()) {
      if (normalizeProjectPath(key) === key) yield key;
    }
    yield* this.#renamed.keys();
    yield* this.#added.keys();
  }

  get(path: string): string | undefined {
    const renamed = this.#renamed.get(path);
    if (renamed !== undefined) return this.#files.get(renamed);
    if (this.#isOwnKey(path)) return this.#files.get(path);
    return this.#added.get(path);
  }

  has(path: string): boolean {
    return this.#renamed.has(path) || this.#isOwnKey(path) || this.#added.has(path);
  }

  /** Add a source unless the project already has a file at `path`. */
  add(path: string, source: string): void {
    if (!this.has(path)) this.#added.set(path, source);
  }

  #isOwnKey(path: string): boolean {
    return this.#files.has(path) && normalizeProjectPath(path) === path;
  }
}

/**
 * What `CompiledProject.sources` answers: host stylesheets first, then the artifact's
 * sources, then the project. Composed per lookup, so no project file is copied.
 */
export class CompileSources implements ProjectFiles {
  readonly #project: ProjectFiles;
  readonly #artifact: ArtifactResolver;
  readonly #generated = new Map<string, string>();

  constructor(project: ProjectFiles, artifact: ArtifactResolver) {
    this.#project = project;
    this.#artifact = artifact;
  }

  *keys(): Generator<string> {
    yield* this.#generated.keys();
    for (const module of this.#artifact.modules()) {
      if (!this.#generated.has(module.id)) yield module.id;
    }
    for (const path of this.#project.keys()) {
      if (!this.#generated.has(path) && this.#artifact.module(path) === null) yield path;
    }
  }

  get(path: string): string | undefined {
    return this.#generated.get(path) ?? this.#artifact.module(path)?.source ?? this.#project.get(path);
  }

  has(path: string): boolean {
    return this.#generated.has(path) || this.#artifact.module(path) !== null || this.#project.has(path);
  }

  addGenerated(id: string, source: string): void {
    this.#generated.set(id, source);
  }
}
