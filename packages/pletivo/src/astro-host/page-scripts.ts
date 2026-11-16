/**
 * `injectScript("page", code)` scripts, bundled into one browser module.
 *
 * An integration's page script is module source: it imports packages (`alpinejs`) and
 * Vite virtual modules (`virtual:@astrojs/alpinejs/entrypoint`) that a browser cannot
 * resolve. Astro bundles every page script into one client entry; the build, the dev
 * server and `pletivo prepare` all emit the result of this one function inline, so the
 * Bun and Workers hosts carry the same code. Where this differs from Astro, see
 * `docs/todos/009`.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import type { BunPlugin, Loader } from "bun";
import { preactResolver } from "../islands-bundle";
import { extensionForLoader, loadViteId, resolveViteId } from "./vite-plugins";

const ENTRY = "pletivo:page-scripts";
const SCRIPT_PREFIX = "pletivo:page-script:";
/**
 * Never on disk. Inside the project root, so what the scripts and the Vite virtual
 * modules import resolves from its `node_modules`, with browser conditions.
 */
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
    throw: false,
    plugins: [pageScriptsPlugin(scripts, projectRoot)],
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
  return inlineSafe((await output.text()).trim());
}

/**
 * `</script` would end the inline tag. `<\/script` means the same in a string, template,
 * regular expression or comment, the only places minified code holds it.
 */
function inlineSafe(code: string): string {
  const escaped = code.replace(/<\/(script)/gi, (_match, name: string) => `<\\/${name}`);
  // `<!--` then `<script` puts the HTML parser in its double-escaped state, where
  // `</script>` no longer ends the tag. Escaping either would change what a regex means.
  if (escaped.includes("<!--") && /<script/i.test(escaped)) {
    throw new Error(
      `[pletivo] the bundled injectScript("page") scripts contain "<!--" and "<script", ` +
        "which an inline <script> cannot hold",
    );
  }
  return escaped;
}

interface VirtualSource {
  contents: string;
  loader: Loader;
}

/**
 * The entry imports each script as its own module, in injection order: each keeps its
 * own top-level scope, as it did in its own `<script type="module">`.
 */
function pageScriptsPlugin(scripts: readonly string[], projectRoot: string): BunPlugin {
  const dir = path.join(projectRoot, VIRTUAL_DIR);
  const entryPath = path.join(dir, "entry.js");
  const entry = scripts.map((_, index) => `import ${JSON.stringify(SCRIPT_PREFIX + index)};`).join("\n");
  const sources = new Map<string, VirtualSource>([[entryPath, { contents: entry, loader: "js" }]]);
  scripts.forEach((code, index) => sources.set(path.join(dir, `${index}.js`), { contents: code, loader: "js" }));
  let preact: ReturnType<typeof preactResolver> | undefined;

  return {
    name: "pletivo-page-scripts",
    setup(build) {
      build.onResolve({ filter: /^pletivo:page-(scripts|script:\d+)$/ }, (args) => {
        if (args.path === ENTRY) return { path: entryPath };
        const index = args.path.slice(SCRIPT_PREFIX.length);
        return { path: path.join(dir, `${index}.js`) };
      });

      // A Vite virtual module becomes a file under `dir`, so its own imports resolve
      // like the scripts' do.
      build.onResolve({ filter: /^(virtual:|\/@|@id\/|\0virtual:)/ }, async (args) => {
        const id = (await resolveViteId(args.path, args.importer)) ?? args.path;
        const loaded = await loadViteId(id);
        if (loaded) {
          const file = path.join(dir, "virtual", `${Bun.hash(id).toString(16)}${extensionForLoader(loaded.loader)}`);
          sources.set(file, { contents: loaded.code, loader: loaded.loader });
          return { path: file };
        }
        if (path.isAbsolute(id) && existsSync(id)) return { path: id };
        throw new Error(`no Vite plugin resolves or loads ${JSON.stringify(args.path)}`);
      });

      // Inside a virtual module, `/src/x` is Vite's root-relative id for a project file.
      build.onResolve({ filter: /^\/[^@]/ }, (args) => {
        if (!args.importer.startsWith(dir + path.sep) || existsSync(args.path)) return undefined;
        return { path: Bun.resolveSync(`.${args.path}`, projectRoot) };
      });

      // Bun applies tsconfig `paths` here too, and a repo may map preact onto its SSR
      // stubs (docs/todos/013); take preact the way island bundles do.
      build.onResolve({ filter: /^preact(\/[^/]+)?$/ }, (args) => {
        preact ??= preactResolver(projectRoot);
        return { path: args.path === "preact" ? preact.main : preact.subpath(args.path.slice("preact/".length)) };
      });

      build.onLoad({ filter: /__pletivo_page_scripts__[\\/]/ }, (args) => {
        const source = sources.get(args.path);
        return source === undefined ? undefined : { contents: source.contents, loader: source.loader };
      });
    },
  };
}
