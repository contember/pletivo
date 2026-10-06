/**
 * Turns a virtual file map into the JavaScript module bundle a Worker Loader executes.
 * Every module the isolate sees is compiled here; workerd has no `eval`. See `compile/`.
 */

import { normalizeProjectPath } from "./artifact.ts";
import type { ExecutableEntry } from "./compiled-program.ts";
import { bundled, compileCached } from "./compile/compile-file.ts";
import { emitProject } from "./compile/emit.ts";
import { linkModule, linkStylesheet } from "./compile/link.ts";
import { ImportResolver } from "./compile/resolve.ts";
import type { CompiledProject, CompileProjectOptions } from "./compile/types.ts";
import { CompileWalk } from "./compile/walk-state.ts";
import { EMPTY_ARTIFACT_RESOLVER } from "./project-artifact.ts";

export { isExecutableModule } from "./compile/module-kind.ts";
export { UnsupportedFileError } from "./compile/source-module.ts";
export type { CompiledProject, CompileProjectOptions } from "./compile/types.ts";

/**
 * Compile what `entries` reaches, or every module-shaped file when it names none.
 * A reachable file that needs an unsupported transpiler throws. A file nothing
 * reaches is never read, so its syntax errors never surface.
 */
export async function compileProject(options: CompileProjectOptions): Promise<CompiledProject> {
  const { compiler = bundled, cache } = options;
  const artifact = options.artifact?.resolver ?? EMPTY_ARTIFACT_RESOLVER;
  const walk = new CompileWalk(options.files, artifact, options.srcDir);
  const resolver = new ImportResolver(walk, {
    artifact,
    tailwind: options.tailwind,
    assets: options.assets,
  });

  // Materialised before the walk: the project gains `astro:assets` sources during it.
  const seeds = (options.entries ?? walk.projectPaths()).map(normalizeProjectPath);
  const entries: ExecutableEntry[] = [];
  for (const seed of seeds) {
    const module = walk.projectModule(seed);
    if (module !== null) entries.push({ moduleId: module.id, executionName: module.executionName });
  }

  // Linking one file claims the files it imports, which appends them to this walk.
  for (const module of walk.pending()) {
    if (module.kind === "css") {
      await linkStylesheet(walk, resolver, module);
    } else {
      await linkModule(walk, resolver, module, await compileCached(module, compiler, cache));
    }
  }

  return emitProject(walk, entries);
}
