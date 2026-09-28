/**
 * Turns a virtual file map into the module bundle a Worker Loader executes.
 *
 * This is the whole of the "no filesystem" problem in one place. The Bun host lets
 * Bun's loader compile `.astro` on import and resolve the rest off disk; here every
 * module the isolate will ever see has to be named in the bundle, so each one is
 * compiled here: `.astro` through `@astrojs/compiler`, `.js` verbatim, and the import
 * specifiers rewritten to point at each other by bundle name.
 *
 * The Loader takes JavaScript, and the compiler copies `.astro` frontmatter into its
 * output verbatim — `export interface Props` included. So every module goes through
 * `stripTypes` on the way out, which also compiles the JSX in a `.tsx` page. That
 * runs *here*, in the host worker, which is the only place it can: workerd has no
 * `eval`, so nothing in the isolate could do it.
 *
 * The parts live in `compile/`:
 * - `walk-state.ts` — what the walk accumulates, module claiming and every project file read;
 * - `resolve.ts` — one specifier of one importer to its target;
 * - `resolve-in-files.ts` — which file map key a resolved specifier names;
 * - `compile-file.ts` — one file's compile, which is what the compile cache holds;
 * - `link.ts` — one compiled file's edges and rewritten code, which a cache hit still pays;
 * - `emit.ts` — the finished walk as a `CompiledProject`.
 *
 * ## The walk is demand-driven
 *
 * Given `entries`, only what those pages' import graphs reach is compiled
 * (`docs/todos/023 §4`). Resolving a specifier is the single place that decides a
 * module has to be in the bundle, so claiming it there is also how the walk discovers
 * it. Two things follow. The queue is drained with an index cursor rather than
 * `shift()`, because resolution appends mid-walk. And the bundle name has to be a pure
 * function of the path, because two pages reach a shared module in orders of their own
 * and a name that moved with discovery would address one program twice.
 *
 * Without `entries` every module-shaped file is compiled, which is what a full
 * `pletivo build` wants.
 *
 * ## The per-file work is cacheable, the walk is not
 *
 * `compileFile` (reached through `compileCached`, which owns the cache hit/miss) is
 * everything that depends only on `(path, source, compiler)` — the wasm transform,
 * sucrase, the specifiers — and it is what `options.cache` holds.
 * `linkModule` is everything the file *set* decides, and it runs on a hit too, which is
 * why every side effect that lives inside resolution needs no storing. See
 * `compile-cache.ts`.
 */

import { normalizeProjectPath } from "./artifact.ts";
import { bundled, compileCached } from "./compile/compile-file.ts";
import { emitProject } from "./compile/emit.ts";
import { linkModule, linkStylesheet } from "./compile/link.ts";
import { ImportResolver } from "./compile/resolve.ts";
import type { CompiledProject, CompileProjectOptions } from "./compile/types.ts";
import { CompileWalk } from "./compile/walk-state.ts";
import { EMPTY_ARTIFACT_RESOLVER } from "./project-artifact.ts";

export { classifyStyles } from "./compile/compile-file.ts";
export { isExecutableModule } from "./compile/module-kind.ts";
export { importQuery, isContentApi } from "./compile/resolve.ts";
export { resolveInFiles } from "./compile/resolve-in-files.ts";
export { UnsupportedFileError } from "./compile/source-module.ts";
export type {
  AstroStyles,
  CompiledProject,
  CompileProjectOptions,
  ProjectContent,
  StyleBlock,
} from "./compile/types.ts";

/**
 * Compile what `entries` reaches, or every module-shaped file when it names none.
 *
 * Files the bundle has no use for (`.md`, images, `astro.config.mjs` outside the
 * graph) are simply not modules and are skipped; a file that *is* reachable but
 * needs a transpiler throws, because silently omitting it turns into an
 * unresolved import inside the isolate, which is much harder to read.
 *
 * A file nothing reaches is never read, so a syntax error in it never surfaces; see
 * `docs/todos/023 §10`.
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

  // Materialised before the walk, because the project can gain the `astro:assets`
  // sources part-way through it.
  const seeds = (options.entries ?? walk.projectPaths()).map(normalizeProjectPath);
  const entries: string[] = [];
  for (const seed of seeds) {
    if (walk.projectModule(seed) !== null) entries.push(seed);
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
