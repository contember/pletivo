/**
 * Dev-only Bun plugin running `applyDevCacheBust` on `.ts`/`.tsx`/`.js`/
 * `.jsx` project files. Bun has no transform hook for these extensions,
 * so without this plugin the cache-bust chain breaks one hop past
 * `.astro` pages — a `.astro` page's transitive `.ts` helper stays
 * cached and the JSON/etc. it closes over never reloads.
 *
 * Filter is scoped to `<projectRoot>/<srcDir>/…` so node_modules entries
 * stay on Bun's native loader; returning a pass-through for dependency
 * code would break CJS default-export interop.
 */

import path from "path";
import { applyDevCacheBust, getDevVersion, stripQuery } from "./dev-cache";
import { escapeRegex } from "./escape-regex";

const registeredScopes = new Set<string>();

const LOADER_FOR_EXT: Record<string, "ts" | "tsx" | "js" | "jsx"> = {
  ".ts": "ts",
  ".tsx": "tsx",
  ".js": "js",
  ".jsx": "jsx",
};

export async function registerDevTsPlugin(
  projectRoot: string,
  srcDir: string = "src",
): Promise<void> {
  const srcPath = path.join(projectRoot, srcDir);
  if (registeredScopes.has(srcPath)) return;
  registeredScopes.add(srcPath);

  const filter = new RegExp(
    `^${escapeRegex(srcPath + path.sep)}.*\\.(tsx?|jsx?)(?:\\?.*)?$`,
  );

  await Bun.plugin({
    name: `pletivo-dev-ts:${srcPath}`,
    setup(build) {
      build.onLoad({ filter }, async (args) => {
        const cleanPath = stripQuery(args.path);
        // Type-only files have no runtime value; return empty contents so
        // Bun doesn't try to execute `declare` statements.
        if (cleanPath.endsWith(".d.ts")) return { contents: "", loader: "ts" };

        const ext = path.extname(cleanPath).toLowerCase();
        const source = await Bun.file(cleanPath).text();
        return {
          contents: applyDevCacheBust(source, getDevVersion()),
          loader: LOADER_FOR_EXT[ext] ?? "ts",
        };
      });
    },
  });
}
