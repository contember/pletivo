import {
  ANY_PROJECT_IMPORTER,
  parsePreparedSite,
  type ArtifactModule,
  type ArtifactResolution,
  type ArtifactResolutionTarget,
  type ModuleId,
  type PreparedSite,
} from "@pletivo/core/artifact";
import { resolveI18nConfig, type ResolvedI18nConfig } from "@pletivo/core/i18n/config";
import { HOST_ALIASES } from "./host-aliases.ts";
import { normalizeProjectPath } from "./project-path.ts";

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

/**
 * A `pletivo prepare` artifact, validated and bound to this host once.
 * Everything a render needs from it is derived here, not per render.
 */
export interface ProjectArtifact {
  readonly prepared: PreparedSite;
  readonly resolver: ArtifactResolver;
  /** The browser graph of processed `<script>` blocks; never consulted by a render. */
  readonly browserResolver: ArtifactResolver;
  /** Artifact Loader names, used only to keep startup diagnostics source-aware. */
  readonly moduleNames: ReadonlySet<string>;
  /** `config.i18n`, resolved once; `null` for a project without one. */
  readonly i18n: ResolvedI18nConfig | null;
}

/** Validate an untrusted artifact and bind it to the host externals it may use. */
export function loadProjectArtifact(value: unknown): ProjectArtifact {
  const prepared = parsePreparedSite(value);
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

  for (const resolution of prepared.artifact.resolutions) {
    if (resolution.target.kind === "external" && !HOST_ALIASES.has(resolution.target.specifier)) {
      throw new UnsupportedArtifactExternalError(resolution.target.specifier);
    }
  }

  return {
    prepared,
    resolver: resolverOf(modules, prepared.artifact.resolutions),
    browserResolver: resolverOf(modules, prepared.artifact.browserResolutions ?? []),
    moduleNames: new Set(prepared.artifact.modules.map((module) => executionNameForModuleId(module.id))),
    i18n: resolveI18nConfig(prepared.artifact.config.i18n),
  };
}

/** Exact importer first; a project file falls back to what every project file resolves. */
function resolverOf(
  modules: ReadonlyMap<ModuleId, ArtifactModule>,
  entries: readonly ArtifactResolution[],
): ArtifactResolver {
  const resolutions = new Map<ModuleId, Map<string, ArtifactResolutionTarget>>();
  for (const resolution of entries) {
    let bySpecifier = resolutions.get(resolution.importer);
    if (bySpecifier === undefined) {
      bySpecifier = new Map<string, ArtifactResolutionTarget>();
      resolutions.set(resolution.importer, bySpecifier);
    }
    bySpecifier.set(resolution.specifier, resolution.target);
  }
  const anyProject = resolutions.get(ANY_PROJECT_IMPORTER);
  return {
    module: (id) => modules.get(id) ?? null,
    resolve(importer, specifier) {
      const exact = resolutions.get(importer)?.get(specifier);
      if (exact !== undefined) return exact;
      return importer.startsWith("project:") ? (anyProject?.get(specifier) ?? null) : null;
    },
    modules: () => [...modules.values()],
  };
}

/** The resolver of a render with no artifact: every bare specifier is left to the Loader. */
export const EMPTY_ARTIFACT_RESOLVER: ArtifactResolver = {
  module: () => null,
  resolve: () => null,
  modules: () => [],
};

/** Project source identity used by both producer edges and the Worker compiler. */
export function projectModuleId(path: string): ModuleId {
  return `project:${normalizeProjectPath(path)}`;
}

/** Reversible Loader name derived from every byte of the logical identity. */
export function executionNameForModuleId(id: ModuleId): string {
  const bytes = new TextEncoder().encode(id);
  const encoded = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `module-${encoded}.js`;
}
