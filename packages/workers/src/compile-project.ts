/**
 * Turns a virtual file map into the JavaScript module bundle a Worker Loader executes.
 * Every module the isolate sees is compiled here; workerd has no `eval`. See `compile/`.
 */

import { normalizeProjectPath } from "./project-path.ts";
import type { AstroCompiler } from "./astro-compiler.ts";
import type { CompileCache } from "./compile-cache.ts";
import { compileCached, type AstroCompileOptions } from "./compile/compile-file.ts";
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
import {
  EMPTY_ARTIFACT_RESOLVER,
  type ArtifactResolver,
  type ProjectArtifact,
  type ProjectIslands,
} from "./artifact.ts";
import type {
  ExecutableEntry,
  ProgramIslandsRequirement,
  ProgramMarkdownPlugin,
  ProgramMarkdownRequirement,
} from "./compiled-program.ts";
import { UnsupportedFileError } from "./compile/source-module.ts";
import { RUNTIME_MODULES } from "./generated/runtime-modules.ts";

export { isExecutableModule } from "./compile/module-kind.ts";
export { UnresolvedImportError, UnsupportedFileError } from "./compile/source-module.ts";
export type { UnresolvedImportKind } from "./compile/source-module.ts";
export type { CompiledProject, CompileProjectOptions } from "./compile/types.ts";

/**
 * Compile what `entries` reaches, or every module-shaped file when it names none.
 * A reachable file that needs an unsupported transpiler throws. A file nothing
 * reaches is never read, so its syntax errors never surface.
 */
export async function compileProject(options: CompileProjectOptions): Promise<CompiledProject> {
  const { compiler, cache } = options;
  const artifact = options.artifact?.resolver ?? EMPTY_ARTIFACT_RESOLVER;
  const walk = new CompileWalk(options.files, artifact, options.srcDir, options.artifact?.islands ?? null, options.rootDir);
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

  const compileOptions: AstroCompileOptions = {
    annotateSourceFile: options.annotateSourceFile === true,
    scopedStyleStrategy: options.artifact?.prepared.artifact.config.scopedStyleStrategy,
    compressHTML: options.artifact?.prepared.artifact.config.compressHTML,
    trailingSlash: options.artifact?.prepared.artifact.config.trailingSlash,
    mdx: options.mdx,
  };
  const link = (): Promise<void> => linkPending(walk, resolver, compiler, cache, compileOptions);
  await link();

  // Known only now: whether a collection entry or a `.md` module renders Markdown in this program.
  const markdownConfig = options.artifact?.prepared.artifact.config.markdown;
  const rendersMarkdown = walk.content !== null || walk.usesMarkdown;
  const markdown = markdownConfig !== undefined && rendersMarkdown
    ? markdownRequirement(walk, artifact, markdownConfig)
    : null;
  // Every page: a renderer's `check` sees any non-`.astro` component, and some spend ids there.
  const islands = options.artifact?.islands ? islandsRequirement(walk, options.artifact.islands) : null;
  await link();

  return emitProject(walk, entries, markdown, islands, options.artifact?.prepared.artifact.config.i18n ?? null);
}

/** Compile and link every module the walk claimed and has not linked; linking claims more. */
async function linkPending(
  walk: CompileWalk,
  resolver: ImportResolver,
  compiler: AstroCompiler,
  cache: CompileCache | undefined,
  options: AstroCompileOptions,
): Promise<void> {
  for (const module of walk.pending()) {
    if (module.kind === "css") {
      await linkStylesheet(walk, resolver, module);
    } else {
      await linkModule(walk, resolver, module, await compileCached(module, compiler, cache, options));
    }
  }
}

/** The modules of a Loader program that runs only the given portable plugins, and where it imports each. */
export interface PluginProgram {
  modules: Record<string, string>;
  remarkPlugins: ProgramMarkdownPlugin[];
  rehypePlugins: ProgramMarkdownPlugin[];
}

/** The artifact modules the plugins reach, linked for a program of their own: the MDX isolate's. */
export async function compilePluginProgram(
  artifact: ProjectArtifact,
  compiler: AstroCompiler,
  plugins: { remarkPlugins: readonly PortablePlugin[]; rehypePlugins: readonly PortablePlugin[] },
): Promise<PluginProgram> {
  const walk = new CompileWalk(new Map(), artifact.resolver, undefined);
  const resolver = new ImportResolver(walk, { artifact: artifact.resolver });
  const remarkPlugins = plugins.remarkPlugins.map((entry) => claimPlugin(walk, artifact.resolver, entry));
  const rehypePlugins = plugins.rehypePlugins.map((entry) => claimPlugin(walk, artifact.resolver, entry));
  await linkPending(walk, resolver, compiler, undefined, {
    annotateSourceFile: false,
    scopedStyleStrategy: undefined,
    compressHTML: undefined,
  });
  // The runtime every render program holds; only a plugin that imports a host alias reaches it.
  const modules = walk.usesHostModules
    ? walk.modules
    : Object.fromEntries(Object.entries(walk.modules).filter(([name]) => !Object.hasOwn(RUNTIME_MODULES, name)));
  return { modules, remarkPlugins, rehypePlugins };
}

/** Claim each renderer's server module into the walk and name where the isolate imports it from. */
function islandsRequirement(walk: CompileWalk, islands: ProjectIslands): ProgramIslandsRequirement {
  return {
    projectRoot: islands.projectRoot,
    renderers: islands.renderers.map((renderer) => ({
      name: renderer.name,
      clientEntrypoint: renderer.clientEntrypoint,
      executionName: walk.artifactModule(renderer.server).executionName,
    })),
    scripts: islands.scripts,
  };
}

/** Claim each plugin's module into the walk and name where the isolate imports it from. */
function markdownRequirement(
  walk: CompileWalk,
  artifact: ArtifactResolver,
  config: ArtifactMarkdownConfig,
): ProgramMarkdownRequirement {
  const plugin = (entry: PortablePlugin): ProgramMarkdownPlugin => claimPlugin(walk, artifact, entry);
  const requirement: ProgramMarkdownRequirement = {
    remarkPlugins: config.remarkPlugins.map(plugin),
    rehypePlugins: config.rehypePlugins.map(plugin),
  };
  if (config.remarkRehype !== undefined) requirement.remarkRehype = config.remarkRehype;
  if (config.gfm !== undefined) requirement.gfm = config.gfm;
  return requirement;
}

/** Claim a plugin's module into the walk and name where the isolate imports it from. */
function claimPlugin(walk: CompileWalk, artifact: ArtifactResolver, entry: PortablePlugin): ProgramMarkdownPlugin {
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
}
