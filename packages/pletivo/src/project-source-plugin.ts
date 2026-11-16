/**
 * Bun plugin for the project's own `.ts`/`.tsx`/`.mts`/`.js`/`.jsx`/`.mjs` files. Bun has no
 * transform hook for these extensions, so this `onLoad` is the only place to:
 *
 * - substitute `import.meta.env` with Astro's values, as `.astro` and `.mdx` get it;
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
import { substituteImportMetaEnv, type SourceLoader } from "./import-meta-env";

const registeredScopes = new Set<string>();

const LOADER_FOR_EXT: Record<string, SourceLoader> = {
  ".ts": "ts",
  ".mts": "ts",
  ".tsx": "tsx",
  ".js": "js",
  ".mjs": "js",
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

        const loader = LOADER_FOR_EXT[path.extname(cleanPath).toLowerCase()] ?? "ts";
        const source = substituteImportMetaEnv(await Bun.file(cleanPath).text(), loader);
        return {
          contents: applyDevCacheBust(source, getDevVersion()),
          loader,
        };
      });
    },
  });
}
