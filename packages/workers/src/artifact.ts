import type {
  ArtifactModule,
  ArtifactResolutionTarget,
  ModuleId,
  PreparedSite,
} from "@pletivo/core/artifact";

export type { PreparedSite };

/** An artifact external the Workers host does not deliberately implement. */
export class UnsupportedArtifactExternalError extends Error {
  constructor(readonly specifier: string) {
    super(
      `[pletivo-workers] the site artifact requires unsupported host external ` +
        `${JSON.stringify(specifier)}. Re-run \`pletivo prepare\` with a supported integration.`,
    );
    this.name = "UnsupportedArtifactExternalError";
  }
}

/** Two module owners attempted to use the same logical identity. */
export class ModuleIdentityCollisionError extends Error {
  constructor(
    readonly moduleId: ModuleId,
    reason: string,
  ) {
    super(`[pletivo-workers] module identity ${JSON.stringify(moduleId)} collides: ${reason}`);
    this.name = "ModuleIdentityCollisionError";
  }
}

const RESERVED_ARTIFACT_PREFIXES = ["project:", "generated:", "host:"];

/** A normalized, validated view over an optional Artifact V2 graph. */
export interface ArtifactResolver {
  module(id: ModuleId): ArtifactModule | null;
  resolve(importer: ModuleId, specifier: string): ArtifactResolutionTarget | null;
  modules(): readonly ArtifactModule[];
}

/** Index a validated graph and bind it to the host externals it may use. */
export function bindArtifactResolver(
  prepared: PreparedSite,
  supportedExternals: ReadonlySet<string>,
): ArtifactResolver {
  const modules = new Map<ModuleId, ArtifactModule>();
  for (const module of prepared.artifact.modules) {
    const reserved = RESERVED_ARTIFACT_PREFIXES.find((prefix) => module.id.startsWith(prefix));
    if (reserved !== undefined) {
      throw new ModuleIdentityCollisionError(
        module.id,
        `${JSON.stringify(reserved)} is reserved for Worker-owned modules`,
      );
    }
    modules.set(module.id, module);
  }

  const resolutions = new Map<ModuleId, Map<string, ArtifactResolutionTarget>>();
  for (const resolution of prepared.artifact.resolutions) {
    if (
      resolution.target.kind === "external" &&
      !supportedExternals.has(resolution.target.specifier)
    ) {
      throw new UnsupportedArtifactExternalError(resolution.target.specifier);
    }
    let bySpecifier = resolutions.get(resolution.importer);
    if (bySpecifier === undefined) {
      bySpecifier = new Map<string, ArtifactResolutionTarget>();
      resolutions.set(resolution.importer, bySpecifier);
    }
    bySpecifier.set(resolution.specifier, resolution.target);
  }

  return {
    module: (id) => modules.get(id) ?? null,
    resolve: (importer, specifier) => resolutions.get(importer)?.get(specifier) ?? null,
    modules: () => prepared.artifact.modules,
  };
}

/** Project source identity used by both producer edges and the Worker compiler. */
export function projectModuleId(path: string): ModuleId {
  return `project:${normalizeProjectPath(path)}`;
}

/** Normalize separators and dot segments without touching URL/package semantics. */
export function normalizeProjectPath(path: string): string {
  const normalized: string[] = [];
  for (const segment of path.replace(/\\/g, "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      normalized.pop();
      continue;
    }
    normalized.push(segment);
  }
  return normalized.join("/");
}

/** Reversible Loader name derived from every byte of the logical identity. */
export function executionNameForModuleId(id: ModuleId): string {
  const bytes = new TextEncoder().encode(id);
  const encoded = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `module-${encoded}.js`;
}
