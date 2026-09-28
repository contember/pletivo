import type { ArtifactModuleKind, ModuleId } from "@pletivo/core/artifact";
import type { ResolvedModuleEdge } from "../module-graph.ts";

/** A module the walk has claimed a bundle name for. */
export interface SourceModule {
  id: ModuleId;
  legacyKey: string;
  kind: ArtifactModuleKind;
  source: string;
  compilePath: string;
  executionName: string;
  origin: "project" | "artifact" | "generated";
}

export type ModuleDescriptor = Omit<SourceModule, "executionName">;

/** One specifier of one importer, resolved: the graph edge and the rewritten specifier. */
export interface ResolutionUse {
  edge: ResolvedModuleEdge;
  rewritten: string;
  targetLegacyKey: string | null;
}

/** A project file the isolate cannot be given, and why. */
export class UnsupportedFileError extends Error {
  constructor(readonly file: string, reason: string) {
    super(`[pletivo-workers] cannot compile ${JSON.stringify(file)}: ${reason}`);
    this.name = "UnsupportedFileError";
  }
}

export function unresolvedImport(
  importer: SourceModule,
  specifier: string,
  reason: string,
): UnsupportedFileError {
  return new UnsupportedFileError(
    importer.compilePath,
    `import ${JSON.stringify(specifier)} from ${JSON.stringify(importer.id)} is unresolved: ${reason}`,
  );
}
