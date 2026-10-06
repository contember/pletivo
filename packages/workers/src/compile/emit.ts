import type { ExecutableEntry, ResolvedStyleGraph } from "../compiled-program.ts";
import { ENV_CLIENT_SPECIFIER, ENV_SERVER_SPECIFIER, type ProjectEnvUse } from "../env.ts";
import {
  CONTENT_MODULE_NAME,
  GENERATED_MODULES,
  IMAGE_MODULE_NAME,
  ISOLATE_ENTRY_MODULE_NAME,
} from "../generated/runtime-modules.ts";
import type { CompiledProject } from "./types.ts";
import type { CompileWalk } from "./walk-state.ts";

/** The finished walk as a `CompiledProject`: runtime modules added, program and style graph built. */
export function emitProject(walk: CompileWalk, entries: ExecutableEntry[]): CompiledProject {
  const { content } = walk;
  if (content !== null) walk.modules[CONTENT_MODULE_NAME] = GENERATED_MODULES[CONTENT_MODULE_NAME];
  // The content runtime needs it too: an `image()` schema names the output file.
  const images = walk.usesImages || content !== null;
  if (images) walk.modules[IMAGE_MODULE_NAME] = GENERATED_MODULES[IMAGE_MODULE_NAME];

  return {
    program: {
      mainModule: ISOLATE_ENTRY_MODULE_NAME,
      modules: walk.modules,
      entries,
      requirements: {
        content,
        images,
        importMetaEnv: walk.usesImportMetaEnv,
        env: envUse(walk.usedEnv, walk.envNames),
      },
    },
    styleGraph: emitStyleGraph(walk),
    sources: walk.sources,
    urlAssets: walk.urlAssets,
  };
}

function emitStyleGraph(walk: CompileWalk): ResolvedStyleGraph {
  return {
    modules: walk.moduleIds,
    executionEdges: walk.executionEdges,
    styleEdges: walk.styleEdges,
    styles: walk.moduleIds.flatMap((moduleId) => {
      const declared = walk.styles.get(moduleId);
      return declared === undefined ? [] : [{ moduleId, scope: declared.scope, blocks: declared.blocks }];
    }),
  };
}

/**
 * Which `astro:env` modules the bundle needs, and the names each has to export.
 * A specifier that named nothing (namespace or dynamic import) still gets an empty list.
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
