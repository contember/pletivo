import type { ArtifactModuleKind, ModuleId } from "@pletivo/core/artifact";

/** A module's stable identity before and after compilation. */
export interface ResolvedModuleIdentity {
  id: ModuleId;
  /** Filename identity used by compilers, notably Astro's scoped CSS transform. */
  compilePath: string;
  /** Loader name assigned after compilation, absent for non-executable modules. */
  executionName: string | null;
}

/** One source available to the canonical resolver. */
export interface ResolvedModule {
  identity: ResolvedModuleIdentity;
  kind: ArtifactModuleKind;
  source: string;
}

export interface ResolvedModuleTarget {
  kind: "module";
  id: ModuleId;
}

export interface ResolvedExternalTarget {
  kind: "external";
  specifier: string;
}

export type ResolvedTarget = ResolvedModuleTarget | ResolvedExternalTarget;

/** What downstream processing should do with an import edge. */
export type ResolvedEdgeKind = "execution" | "style";

/** One source-order resolution result shared by rewriting and graph consumers. */
export interface ResolvedModuleEdge {
  importer: ModuleId;
  specifier: string;
  target: ResolvedTarget;
  kind: ResolvedEdgeKind;
}

/** Arrays preserve resolver traversal and source import order. */
export interface ResolvedModuleGraph {
  modules: ResolvedModule[];
  edges: ResolvedModuleEdge[];
}
