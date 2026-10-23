import type { ArtifactModuleKind, ModuleId } from "@pletivo/core/artifact";

/** A module the walk has claimed a bundle name for. */
export interface SourceModule {
  id: ModuleId;
  kind: ArtifactModuleKind;
  source: string;
  compilePath: string;
  executionName: string;
  origin: "project" | "artifact" | "generated";
}

/** One specifier of one importer, resolved: what it names and what the bundle spells it as. */
export type ResolutionUse =
  | { kind: "module"; module: SourceModule; rewritten: string }
  | { kind: "external"; specifier: string; rewritten: string };

/** A project file the isolate cannot be given, and why. */
export class UnsupportedFileError extends Error {
  constructor(readonly file: string, reason: string) {
    super(`[pletivo-workers] cannot compile ${JSON.stringify(file)}: ${reason}`);
    this.name = "UnsupportedFileError";
  }
}

/**
 * Why an import is unresolved. Only `missing` can be fixed by preparing the artifact
 * again; every other kind fails the same way against any artifact.
 */
export type UnresolvedImportKind =
  /** No project file, artifact resolution or host alias answers the specifier. */
  | "missing"
  /** The root of `pletivo`, `@pletivo/runtime` or `@pletivo/core`, which the host does not provide. */
  | "unsupported-package-root"
  /** The specifier names a host external that has no host alias. */
  | "unsupported-host-external"
  /** A `?raw`, `?inline` or `?url` import of a file the project does not have. */
  | "query-target-not-found"
  /** An image import whose metadata the project assets cannot give. */
  | "image-metadata-unavailable"
  /** A project file of a kind the walk does not compile. */
  | "unsupported-target-kind"
  /** The `astro:assets` entry the host generates is not in the walk. */
  | "asset-entry-not-generated"
  /** The rewrite met a specifier the link step did not resolve. */
  | "rewrite-mismatch"
  /** A CSS `@import` that resolves to something other than a CSS module. */
  | "css-import-not-css";

/** An import of a project or artifact module that nothing answers. */
export class UnresolvedImportError extends UnsupportedFileError {
  constructor(
    file: string,
    readonly importer: ModuleId,
    readonly specifier: string,
    readonly kind: UnresolvedImportKind,
    readonly reason: string,
  ) {
    super(file, `import ${JSON.stringify(specifier)} from ${JSON.stringify(importer)} is unresolved: ${reason}`);
    this.name = "UnresolvedImportError";
  }
}

export function unresolvedImport(
  importer: SourceModule,
  specifier: string,
  kind: UnresolvedImportKind,
  reason: string,
): UnresolvedImportError {
  return new UnresolvedImportError(importer.compilePath, importer.id, specifier, kind, reason);
}
