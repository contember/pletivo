import { parsePreparedSite, type PreparedSite } from "@pletivo/core/artifact";
import {
  bindArtifactResolver,
  executionNameForModuleId,
  type ArtifactResolver,
} from "./artifact.ts";
import { HOST_ALIASES } from "./host-aliases.ts";

const SUPPORTED_ARTIFACT_EXTERNALS: ReadonlySet<string> = new Set(HOST_ALIASES.keys());

/** Held only by this module, so `loadProjectArtifact` is the one way to construct. */
const LOADED: unique symbol = Symbol("ProjectArtifact");

/**
 * A `pletivo prepare` artifact, validated and bound to this host once.
 * Everything a render needs from it is derived here, not per render.
 */
export class ProjectArtifact {
  constructor(
    loaded: typeof LOADED,
    readonly prepared: PreparedSite,
    readonly resolver: ArtifactResolver,
    /** Artifact Loader names, used only to keep startup diagnostics source-aware. */
    readonly moduleNames: ReadonlySet<string>,
  ) {
    if (loaded !== LOADED) throw new TypeError("use loadProjectArtifact()");
  }
}

/** Validate an untrusted artifact and bind it to the host externals it may use. */
export function loadProjectArtifact(value: unknown): ProjectArtifact {
  const prepared = parsePreparedSite(value);
  return new ProjectArtifact(
    LOADED,
    prepared,
    bindArtifactResolver(prepared, SUPPORTED_ARTIFACT_EXTERNALS),
    new Set(prepared.artifact.modules.map((module) => executionNameForModuleId(module.id))),
  );
}

/** The resolver of a render with no artifact: every bare specifier is left to the Loader. */
export const EMPTY_ARTIFACT_RESOLVER: ArtifactResolver = {
  module: () => null,
  resolve: () => null,
  modules: () => [],
};
