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

/** An import of a project or artifact module that nothing answers. */
export class UnresolvedImportError extends UnsupportedFileError {
  constructor(
    file: string,
    readonly importer: ModuleId,
    readonly specifier: string,
    readonly reason: string,
  ) {
    super(file, `import ${JSON.stringify(specifier)} from ${JSON.stringify(importer)} is unresolved: ${reason}`);
    this.name = "UnresolvedImportError";
  }
}

export function unresolvedImport(
  importer: SourceModule,
  specifier: string,
  reason: string,
): UnresolvedImportError {
  return new UnresolvedImportError(importer.compilePath, importer.id, specifier, reason);
}
