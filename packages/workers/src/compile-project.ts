/**
 * Turns a virtual file map into the JavaScript module bundle a Worker Loader executes.
 * Every module the isolate sees is compiled here; workerd has no `eval`. See `compile/`.
 */

import { normalizeProjectPath } from "./project-path.ts";
import { bundled, compileCached } from "./compile/compile-file.ts";
import { emitProject } from "./compile/emit.ts";
import { linkModule, linkStylesheet } from "./compile/link.ts";
import { ImportResolver } from "./compile/resolve.ts";
import type { CompiledProject, CompileProjectOptions } from "./compile/types.ts";
import { CompileWalk } from "./compile/walk-state.ts";
import {
  ANY_PROJECT_IMPORTER,
  type ArtifactMarkdownConfig,
  type PortablePlugin,
} from "@pletivo/core/artifact";
import { EMPTY_ARTIFACT_RESOLVER, type ArtifactResolver } from "./artifact.ts";
import type {
  ExecutableEntry,
  ProgramMarkdownPlugin,
  ProgramMarkdownRequirement,
} from "./compiled-program.ts";
import { UnsupportedFileError } from "./compile/source-module.ts";

export { isExecutableModule } from "./compile/module-kind.ts";
export { UnresolvedImportError, UnsupportedFileError } from "./compile/source-module.ts";
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

  const link = async (): Promise<void> => {
    // Linking one file claims the files it imports, which appends them to this walk.
    for (const module of walk.pending()) {
      if (module.kind === "css") {
        await linkStylesheet(walk, resolver, module);
      } else {
        const compiled = await compileCached(module, compiler, cache, options.annotateSourceFile === true);
        await linkModule(walk, resolver, module, compiled);
      }
    }
  };
  await link();

  // Known only now: whether a collection entry can render Markdown in this program.
  const markdownConfig = options.artifact?.prepared.artifact.config.markdown;
  const rendersMarkdown = options.markdown === true || walk.content !== null;
  const markdown = markdownConfig !== undefined && rendersMarkdown
    ? markdownRequirement(walk, artifact, markdownConfig)
    : null;
  await link();

  return emitProject(walk, entries, markdown, options.artifact?.prepared.artifact.config.i18n ?? null);
}

/** Claim each plugin's module into the walk and name where the isolate imports it from. */
function markdownRequirement(
  walk: CompileWalk,
  artifact: ArtifactResolver,
  config: ArtifactMarkdownConfig,
): ProgramMarkdownRequirement {
  const plugin = (entry: PortablePlugin): ProgramMarkdownPlugin => {
    const target = artifact.resolve(ANY_PROJECT_IMPORTER, entry.module);
    if (target === null || target.kind !== "module") {
      throw new UnsupportedFileError(
        entry.module,
        "a configured Markdown plugin's module is not in the artifact; re-run `pletivo prepare`",
      );
    }
    const module = walk.artifactModule(target.id);
    return entry.options === undefined
      ? { executionName: module.executionName, exportName: entry.export }
      : { executionName: module.executionName, exportName: entry.export, options: entry.options };
  };
  const requirement: ProgramMarkdownRequirement = {
    remarkPlugins: config.remarkPlugins.map(plugin),
    rehypePlugins: config.rehypePlugins.map(plugin),
  };
  if (config.remarkRehype !== undefined) requirement.remarkRehype = config.remarkRehype;
  if (config.gfm !== undefined) requirement.gfm = config.gfm;
  return requirement;
}
