import type { ModuleId } from "@pletivo/core/artifact";
import { projectModuleId } from "../artifact.ts";
import type {
  ExecutableProgram,
  ExecutableRequirements,
  ResolvedStyleGraph,
} from "../compiled-program.ts";
import { ENV_CLIENT_SPECIFIER, ENV_SERVER_SPECIFIER, type ProjectEnvUse } from "../env.ts";
import {
  CONTENT_MODULE_NAME,
  GENERATED_MODULES,
  IMAGE_MODULE_NAME,
  ISOLATE_ENTRY_MODULE_NAME,
} from "../generated/runtime-modules.ts";
import type { ResolvedTarget } from "../module-graph.ts";
import { UnsupportedFileError } from "./source-module.ts";
import type { CompiledProject, ProjectContent } from "./types.ts";
import type { CompileWalk } from "./walk-state.ts";

/** The finished walk as a `CompiledProject`: runtime modules added, program and style graph built. */
export function emitProject(walk: CompileWalk, entries: string[]): CompiledProject {
  let content: ProjectContent | null = null;
  if (walk.usesContent) {
    walk.modules[CONTENT_MODULE_NAME] = GENERATED_MODULES[CONTENT_MODULE_NAME];
    const configFile = walk.contentConfig;
    content = { configModule: configFile === null ? null : (walk.moduleNames.get(configFile) ?? null) };
  }
  // The content runtime needs it too: an `image()` schema names the output file, and
  // `imageOutputPath` is what names it on both hosts.
  const images = walk.usesImages || walk.usesContent;
  if (images) walk.modules[IMAGE_MODULE_NAME] = GENERATED_MODULES[IMAGE_MODULE_NAME];

  const env = envUse(walk.usedEnv, walk.envNames);
  const requirements: ExecutableRequirements = {
    content: content === null ? null : { configExecutionName: content.configModule },
    images,
    importMetaEnv: walk.usesImportMetaEnv,
    env,
  };
  return {
    modules: walk.modules,
    sources: walk.sources,
    moduleNames: walk.moduleNames,
    entries,
    styles: walk.styles,
    imports: walk.imports,
    cssImports: walk.cssImports,
    content,
    images,
    importMetaEnv: walk.usesImportMetaEnv,
    env,
    urlAssets: walk.urlAssets,
    program: emitProgram(walk, entries, requirements),
    styleGraph: emitStyleGraph(walk),
    graph: { modules: walk.graphModules, edges: walk.graphEdges },
  };
}

function emitProgram(
  walk: CompileWalk,
  entries: string[],
  requirements: ExecutableRequirements,
): ExecutableProgram {
  const programEntries = entries.map((file) => {
    const executionName = walk.moduleNames.get(file);
    if (executionName === undefined) {
      throw new UnsupportedFileError(file, "the compiled entry has no execution name");
    }
    return { moduleId: projectModuleId(file), executionName };
  });
  return {
    mainModule: ISOLATE_ENTRY_MODULE_NAME,
    modules: walk.modules,
    entries: programEntries,
    requirements,
  };
}

function emitStyleGraph(walk: CompileWalk): ResolvedStyleGraph {
  const executionEdges = walk.graphEdges
    .filter((edge) => edge.kind === "execution" && edge.target.kind === "module")
    .map((edge) => ({ importer: edge.importer, target: moduleTargetId(edge.target) }));
  const styleEdges = walk.graphEdges
    .filter((edge) => edge.kind === "style" && edge.target.kind === "module")
    .map((edge) => ({ importer: edge.importer, target: moduleTargetId(edge.target) }));
  return {
    modules: walk.graphModules.map((module) => module.identity.id),
    executionEdges,
    styleEdges,
    styles: walk.graphModules.flatMap((module) => {
      const legacyKey = walk.claimedLegacyKey(module.identity.id) ?? module.identity.id;
      const declared = walk.styles.get(legacyKey);
      return declared === undefined
        ? []
        : [{ moduleId: module.identity.id, scope: declared.scope, blocks: declared.blocks }];
    }),
  };
}

function moduleTargetId(target: ResolvedTarget): ModuleId {
  if (target.kind !== "module") {
    throw new Error("[pletivo-workers] an external target cannot become a module edge");
  }
  return target.id;
}

/**
 * Which `astro:env` modules the bundle needs, and the names each has to export.
 *
 * A specifier that was resolved but named nothing — a namespace import, a dynamic
 * `import()` — still yields an entry, with an empty list: the module has to exist, it
 * just takes its whole surface from what the host provided.
 */
function envUse(
  used: ReadonlySet<string>,
  names: ReadonlyMap<string, ReadonlySet<string>>,
): ProjectEnvUse | null {
  if (used.size === 0) return null;
  const of = (specifier: string): string[] | null =>
    used.has(specifier) ? [...(names.get(specifier) ?? [])].sort() : null;
  return { client: of(ENV_CLIENT_SPECIFIER), server: of(ENV_SERVER_SPECIFIER) };
}
