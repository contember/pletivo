/**
 * Bun plugin for the project's own `.ts`/`.tsx`/`.js`/`.jsx` files. Bun has no
 * transform hook for these extensions, so this `onLoad` is the only place to:
 *
 * - substitute `import.meta.env` with Astro's values, as `.astro` and `.mdx` get it;
 * - pick the JSX runtime an Astro renderer integration claims (see `configureProjectJsx`);
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
import { substituteImportMetaEnv } from "./import-meta-env";

const registeredScopes = new Set<string>();

/** The JSX import source for project `.jsx`/`.tsx`, or null to leave it to tsconfig. */
let jsxImportSource: string | null = null;

/** Astro's JSX renderer integrations; with more than one, their `include`/`exclude` split the files. */
const JSX_RENDERERS = ["@astrojs/preact", "@astrojs/react", "@astrojs/solid-js"];

/**
 * `@astrojs/preact` compiles project JSX with Preact's runtime whatever tsconfig says.
 * Its `include`/`exclude` are closed over by its Vite plugin, out of pletivo's sight,
 * so with a second JSX renderer the choice stays with tsconfig.
 */
export function configureProjectJsx(hasIntegration: (name: string) => boolean): void {
  const renderers = JSX_RENDERERS.filter(hasIntegration);
  jsxImportSource = renderers.length === 1 && renderers[0] === "@astrojs/preact" ? "preact" : null;
}

/** Prepended on line 1 without a newline, so stack-trace line numbers do not move. */
function withJsxImportSource(source: string, ext: string): string {
  if (jsxImportSource === null || (ext !== ".jsx" && ext !== ".tsx")) return source;
  if (source.includes("@jsxImportSource")) return source;
  return `/** @jsxImportSource ${jsxImportSource} */ ${source}`;
}

const LOADER_FOR_EXT: Record<string, "ts" | "tsx" | "js" | "jsx"> = {
  ".ts": "ts",
  ".tsx": "tsx",
  ".js": "js",
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
    `^${escapeRegex(srcPath + path.sep)}.*\\.(tsx?|jsx?)(?:\\?.*)?$`,
  );

  await Bun.plugin({
    name: `pletivo-project-source:${srcPath}`,
    setup(build) {
      build.onLoad({ filter }, async (args) => {
        const cleanPath = stripQuery(args.path);
        // Type-only files have no runtime value; return empty contents so
        // Bun doesn't try to execute `declare` statements.
        if (cleanPath.endsWith(".d.ts")) return { contents: "", loader: "ts" };

        const ext = path.extname(cleanPath).toLowerCase();
        const source = withJsxImportSource(
          substituteImportMetaEnv(await Bun.file(cleanPath).text()),
          ext,
        );
        return {
          contents: applyDevCacheBust(source, getDevVersion()),
          loader: LOADER_FOR_EXT[ext] ?? "ts",
        };
      });
    },
  });
}
