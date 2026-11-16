/**
 * `injectScript("page", code)` scripts, bundled into one browser module.
 *
 * An integration's page script is module source: it imports packages (`alpinejs`) and
 * Vite virtual modules (`virtual:@astrojs/alpinejs/entrypoint`) that a browser cannot
 * resolve. Astro bundles every page script into one client entry; the build, the dev
 * server and `pletivo prepare` all emit the result of this one function inline, so the
 * Bun and Workers hosts carry the same code.
 */

import path from "node:path";
import type { BunPlugin } from "bun";
import { viteVirtualModulesPlugin } from "./vite-plugins";

const ENTRY = "pletivo:page-scripts";
const SCRIPT_PREFIX = "pletivo:page-script:";
/** Never on disk; placed in the project root so bare imports resolve from its `node_modules`. */
const VIRTUAL_DIR = "__pletivo_page_scripts__";

/** The page scripts as one minified ES module, or null when there are none. */
export async function bundlePageScripts(
  scripts: readonly string[],
  projectRoot: string,
): Promise<string | null> {
  if (scripts.length === 0) return null;
  const result = await Bun.build({
    entrypoints: [ENTRY],
    format: "esm",
    target: "browser",
    minify: true,
    plugins: [pageScriptsPlugin(scripts, projectRoot), viteVirtualModulesPlugin()],
  });
  if (!result.success) {
    const logs = result.logs.map((log) => String(log)).join("\n");
    throw new Error(`[pletivo] bundling the injectScript("page") scripts failed:\n${logs}`);
  }
  const [output, ...rest] = result.outputs;
  // An inline module has no URL to load a chunk, stylesheet or asset from.
  if (output === undefined || output.kind !== "entry-point" || rest.length > 0) {
    const emitted = result.outputs.map((artifact) => `${artifact.kind} ${artifact.path}`).join(", ");
    throw new Error(
      `[pletivo] the injectScript("page") scripts must bundle to one JavaScript module; ` +
        `they emitted: ${emitted}`,
    );
  }
  const code = (await output.text()).trim();
  if (/<\/script/i.test(code)) {
    throw new Error(`[pletivo] the bundled injectScript("page") scripts contain "</script", which would end their inline tag`);
  }
  return code;
}

/**
 * The entry imports each script as its own module, in injection order: each keeps its
 * own top-level scope, as it did in its own `<script type="module">`.
 */
function pageScriptsPlugin(scripts: readonly string[], projectRoot: string): BunPlugin {
  const dir = path.join(projectRoot, VIRTUAL_DIR);
  const entryPath = path.join(dir, "entry.js");
  const entry = scripts.map((_, index) => `import ${JSON.stringify(SCRIPT_PREFIX + index)};`).join("\n");
  const sources = new Map<string, string>([[entryPath, entry]]);
  scripts.forEach((code, index) => sources.set(path.join(dir, `${index}.js`), code));
  return {
    name: "pletivo-page-scripts",
    setup(build) {
      build.onResolve({ filter: /^pletivo:page-(scripts|script:\d+)$/ }, (args) => {
        if (args.path === ENTRY) return { path: entryPath };
        const index = args.path.slice(SCRIPT_PREFIX.length);
        return { path: path.join(dir, `${index}.js`) };
      });
      build.onLoad({ filter: /__pletivo_page_scripts__[\\/][^\\/]+\.js$/ }, (args) => {
        const contents = sources.get(args.path);
        return contents === undefined ? undefined : { contents, loader: "js" };
      });
    },
  };
}
