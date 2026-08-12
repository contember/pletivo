/**
 * Transpiles `@pletivo/runtime` into the JavaScript a Worker Loader can take.
 *
 * The Loader accepts modules, not TypeScript, and workerd has no `eval` — so the
 * TS→JS step cannot happen at request time. It happens here, once, and the result
 * is committed as a string constant that any bundler carries into the host worker
 * unchanged. `test/runtime-modules.test.ts` re-runs this and fails when the
 * committed copy drifts from the source.
 *
 *   bun packages/workers/scripts/build-runtime.ts
 */

import path from "node:path";

const PACKAGE_DIR = path.resolve(import.meta.dir, "..");
const OUT_FILE = path.join(PACKAGE_DIR, "src/generated/runtime-modules.ts");

/**
 * The entries, and the names they take in the module map handed to the isolate.
 *
 * `pletivo-runtime.js` re-exports the Astro shim — what `internalURL` points compiled
 * `.astro` output at — the JSX runtime, and `createPaginate`, in a single bundle so
 * the render-tracking store exists once; see the note in `runtime-entry.ts`.
 * `pletivo-content.js` is the collection runtime, which has to run where the page
 * runs. Everything else the render path needs — the router, the CSS ordering, the
 * compiler — runs in the *host* worker, where the app's own bundler already compiles
 * TypeScript.
 */
interface Entry {
  specifier: string;
  /**
   * `node` keeps `node:async_hooks` external — workerd provides it under
   * `nodejs_compat` and bundling as `browser` would stub it to `{}`.
   *
   * `browser` is for a graph that should reach no Node built-in at all, and it is not
   * a preference. Bun's `node` CJS interop opens the module with
   * `createRequire(import.meta.url)`, and a Worker Loader module has no
   * `import.meta.url`: the isolate died on that line before running a byte of the
   * bundle. `bun` fails differently, leaving `debug` to pick its Node entry and
   * `__require("tty")` at start-up. `browser` sidesteps both, and the `workerd`
   * condition below covers the one package where it overshoots.
   */
  target: "node" | "browser";
  /**
   * Export conditions to prefer over the target's own.
   *
   * workerd is neither a browser nor Node, and the unified ecosystem says so
   * explicitly: `decode-named-character-reference` maps `"workerd"` to its plain
   * entry and `"browser"` to one that calls `document.createElement` at module scope.
   * Asking for `workerd` is the packages' own answer, not an override of them.
   */
  conditions?: string[];
}

const ENTRIES: Record<string, Entry> = {
  "pletivo-runtime.js": {
    specifier: path.join(PACKAGE_DIR, "scripts/runtime-entry.ts"),
    target: "node",
  },
  /**
   * Content collections, with no entry glue at all: `@pletivo/core/content/collection`
   * verbatim, because there is nothing to stitch together.
   *
   * It has to be *in the isolate* rather than in the host worker, unlike the compiler
   * and the CSS pipeline: `content.config.*` is a module that must be executed to
   * yield collection definitions, and the page calling `getCollection()` executes
   * there too. It is one module for the same reason `pletivo-runtime.js` is — the
   * store, the config and `configVersion` are module state, and a page resolving
   * `astro:content` to a second copy would read a store nobody ever filled.
   *
   * It carries Zod and the whole unified/remark pipeline, roughly a megabyte, which
   * is why `compileProject` only puts it in the bundle for a project that reaches for
   * the content API. Both are host-agnostic and both have to run where the page runs,
   * so the alternative is a second implementation — the thing the split exists to
   * avoid.
   *
   * Named by specifier, not by path, and that matters: with an isolated node_modules
   * layout, entering the package through the workspace symlink puts the bundler's
   * resolution root in `packages/workers`, where `js-yaml` and friends are not.
   */
  "pletivo-content.js": {
    specifier: "@pletivo/core/content/collection",
    target: "browser",
    conditions: ["workerd"],
  },
};

/** Of those, the ones `compileProject` adds to every bundle. */
const ALWAYS_BUNDLED = ["pletivo-runtime.js"];

/**
 * `jsxImportSource` is a package name, and sucrase appends `/jsx-runtime` to it, so
 * the JSX a page compiles to imports a module of its own rather than the shared
 * bundle. This is that module: a rename, not a second copy.
 */
const JSX_RUNTIME_MODULE_NAME = "pletivo-jsx-runtime.js";
const JSX_RUNTIME_MODULE =
  'export { jsx, jsxs, jsxDEV, jsxFragment as Fragment } from "./pletivo-runtime.js";\n';

/** Bundle one entry point into a single self-contained module. */
export async function bundleRuntimeModule(entry: Entry): Promise<string> {
  const result = await Bun.build({
    entrypoints: [Bun.resolveSync(entry.specifier, PACKAGE_DIR)],
    target: entry.target,
    conditions: entry.conditions,
    format: "esm",
    minify: false,
  });
  if (!result.success) {
    throw new Error(
      `[pletivo-workers] bundling ${entry.specifier} failed:\n${result.logs.join("\n")}`,
    );
  }
  return result.outputs[0].text();
}

export async function generateRuntimeModules(): Promise<string> {
  const entries: string[] = [];
  for (const [name, entry] of Object.entries(ENTRIES)) {
    const code = await bundleRuntimeModule(entry);
    entries.push(`  ${JSON.stringify(name)}: ${JSON.stringify(code)},`);
  }
  entries.push(`  ${JSON.stringify(JSX_RUNTIME_MODULE_NAME)}: ${JSON.stringify(JSX_RUNTIME_MODULE)},`);
  return [
    "// Generated by scripts/build-runtime.ts. Do not edit.",
    "//",
    "// The JavaScript form of @pletivo/runtime, ready to hand to a Worker Loader.",
    "// Regenerate with: bun packages/workers/scripts/build-runtime.ts",
    "",
    "/** Module name in the Loader bundle -> its source. */",
    "export const GENERATED_MODULES: Readonly<Record<string, string>> = {",
    ...entries,
    "};",
    "",
    "/** The modules every bundle carries. */",
    "export const RUNTIME_MODULES: Readonly<Record<string, string>> = {",
    ...[...ALWAYS_BUNDLED, JSX_RUNTIME_MODULE_NAME].map(
      (name) => `  ${JSON.stringify(name)}: GENERATED_MODULES[${JSON.stringify(name)}],`,
    ),
    "};",
    "",
    "/** The module compiled `.astro` output imports, via the compiler's `internalURL`. */",
    'export const RUNTIME_MODULE_NAME = "pletivo-runtime.js";',
    "",
    "/** The module compiled JSX imports, via sucrase's `jsxImportSource`. */",
    `export const JSX_RUNTIME_MODULE_NAME = ${JSON.stringify(JSX_RUNTIME_MODULE_NAME)};`,
    "",
    "/** The module a project's content API resolves to. Added only when it is reached for. */",
    'export const CONTENT_MODULE_NAME = "pletivo-content.js";',
    "",
  ].join("\n");
}

if (import.meta.main) {
  const source = await generateRuntimeModules();
  // `--stdout` is how `test/runtime-modules.test.ts` re-derives the file. It has to
  // run out here rather than calling `generateRuntimeModules()` in-process: under
  // `bun test`, `Bun.build` resolves bare specifiers from the *test runner's* view
  // and cannot see `packages/core/node_modules`, so the markdown pipeline's imports
  // come back unresolvable. The bundle also embeds cwd-relative module comments, so
  // the subprocess must inherit this one's working directory to match byte for byte.
  if (process.argv[2] === "--stdout") {
    process.stdout.write(source);
  } else {
    await Bun.write(OUT_FILE, source);
    console.log(`wrote ${path.relative(process.cwd(), OUT_FILE)} (${source.length} bytes)`);
  }
}
