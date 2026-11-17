/**
 * Bun plugin for the project's own `.ts`/`.tsx`/`.mts`/`.js`/`.jsx`/`.mjs` files. Bun has no
 * transform hook for these extensions, so this `onLoad` is the only place to:
 *
 * - substitute `import.meta.env` with Astro's values, as `.astro` and `.mdx` get it;
 * - compile files a framework renderer's compiler owns: `.jsx`/`.tsx`, Svelte's
 *   `.svelte.js`/`.svelte.ts` (see `configureProjectCompilers`);
 * - run `applyDevCacheBust` in dev, so the cache-bust chain does not break one hop
 *   past `.astro` pages — a page's transitive `.ts` helper would stay cached and
 *   the JSON/etc. it closes over never reload. A no-op in build.
 *
 * Filter is scoped to `<projectRoot>/<srcDir>/…` so node_modules entries
 * stay on Bun's native loader; returning a pass-through for dependency
 * code would break CJS default-export interop.
 */

import path from "path";
import { applyDevCacheBust, getDevVersion, stripQuery } from "@pletivo/core/dev-cache";
import { escapeRegex } from "@pletivo/core/escape-regex";
import { offeredSuffix, type FrameworkCompiler } from "@pletivo/core/framework-compile/types";
import { substituteImportMetaEnv, type SourceLoader } from "./import-meta-env";

const registeredScopes = new Set<string>();

/** The server compilers for project files; empty leaves every file to Bun's loader as written. */
let projectCompilers: readonly FrameworkCompiler[] = [];

/**
 * The compilers whose suffixes a project file may end in. A file goes to the compilers of its
 * longest matching suffix, in order; their output CSS must already be imported by the module.
 */
export function configureProjectCompilers(compilers: readonly FrameworkCompiler[]): void {
  projectCompilers = compilers;
}

async function compileProjectFile(source: string, filename: string): Promise<{ code: string; loader: SourceLoader } | null> {
  const suffix = offeredSuffix(filename, projectCompilers.flatMap((compiler) => compiler.extensions));
  if (suffix === null) return null;
  for (const compiler of projectCompilers) {
    if (!compiler.extensions.includes(suffix)) continue;
    const output = await compiler.compile({ source, filename, target: "server" });
    if (output === null) continue;
    if (output.css !== null) throw new Error(`${filename}: a compiled project module's CSS must be imported by the module`);
    return { code: output.code, loader: output.loader };
  }
  return null;
}

// `.js`/`.mjs` load as `jsx`: Bun's native loader accepts JSX in them too.
const LOADER_FOR_EXT: Record<string, SourceLoader> = {
  ".ts": "ts",
  ".mts": "ts",
  ".tsx": "tsx",
  ".js": "jsx",
  ".mjs": "jsx",
  ".jsx": "jsx",
};

export async function registerProjectSourcePlugin(
  projectRoot: string,
  srcDir: string = "src",
): Promise<void> {
  const srcPath = path.join(projectRoot, srcDir);
  if (registeredScopes.has(srcPath)) return;
  registeredScopes.add(srcPath);

  const filter = new RegExp(
    `^${escapeRegex(srcPath + path.sep)}.*\\.(tsx?|jsx?|mts|mjs)(?:\\?.*)?$`,
  );

  await Bun.plugin({
    name: `pletivo-project-source:${srcPath}`,
    setup(build) {
      build.onLoad({ filter }, async (args) => {
        const cleanPath = stripQuery(args.path);
        // Type-only files have no runtime value; return empty contents so
        // Bun doesn't try to execute `declare` statements.
        if (/\.d\.m?ts$/.test(cleanPath)) return { contents: "", loader: "ts" };

        const ext = path.extname(cleanPath).toLowerCase();
        const loader = LOADER_FOR_EXT[ext] ?? "ts";
        const source = substituteImportMetaEnv(await Bun.file(cleanPath).text(), loader);
        const compiled = await compileProjectFile(source, cleanPath);
        return {
          contents: applyDevCacheBust(compiled?.code ?? source, getDevVersion()),
          loader: compiled?.loader ?? loader,
        };
      });
    },
  });
}
