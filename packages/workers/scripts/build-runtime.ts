/**
 * Bundles the isolate-side runtime into JavaScript a Worker Loader can take; workerd
 * has no `eval`, so this cannot happen at request time. The output is committed and
 * `test/runtime-modules.test.ts` fails when it drifts.
 *
 *   bun packages/workers/scripts/build-runtime.ts
 */

import path from "node:path";
import { builtinModules } from "node:module";
import type { BunPlugin } from "bun";
import { parse } from "acorn";

const PACKAGE_DIR = path.resolve(import.meta.dir, "..");
const OUT_FILE = path.join(PACKAGE_DIR, "src/generated/runtime-modules.ts");

/** An entry bundled into one module of the map handed to the isolate. */
export interface Entry {
  specifier: string;
  /**
   * `node` keeps `node:async_hooks` external (`browser` would stub it to `{}`).
   * `browser` is required for CJS dependencies: Bun's `node` interop calls
   * `createRequire(import.meta.url)`, and a Loader module has no `import.meta.url`.
   */
  target: "node" | "browser";
  /** Runtime-provided modules that must stay imports in the generated bundle. */
  external?: string[];
  /**
   * Source file -> the Loader module it is imported as, so the file is never bundled.
   * Keyed by resolved path: any specifier that reaches the file is aliased.
   */
  aliases?: Record<string, string>;
  /** Reject Node built-ins while resolving this module graph. */
  forbidNodeBuiltins?: boolean;
  /**
   * Export conditions to prefer over the target's own. `workerd` matters where a
   * package's `browser` entry touches `document` at module scope.
   */
  conditions?: string[];
}

const ISOLATE_HANDLER_MODULE_NAME = "pletivo-isolate-entry.js";

const ENTRIES: Record<string, Entry> = {
  "pletivo-runtime.js": {
    specifier: path.join(PACKAGE_DIR, "scripts/runtime-entry.ts"),
    target: "node",
  },
  /**
   * Content collections run in the isolate, where `content.config.*` and the page
   * execute. One module, because its AsyncLocalStorage is module state.
   * Named by specifier, not path: a path through the workspace symlink resolves
   * dependencies from `packages/workers`, where `js-yaml` and friends are not.
   */
  "pletivo-content.js": {
    specifier: "@pletivo/core/content/collection",
    target: "browser",
    conditions: ["workerd"],
    // Keep workerd's AsyncLocalStorage; the browser target would stub it.
    external: ["node:async_hooks"],
  },
  /** The image pipeline; in the isolate because `getImage()` runs in page frontmatter. */
  "pletivo-image.js": {
    specifier: "@pletivo/core/image",
    target: "browser",
  },
  "pletivo-isolate-protocol.js": {
    specifier: path.join(PACKAGE_DIR, "src/isolate-protocol.ts"),
    target: "browser",
    forbidNodeBuiltins: true,
  },
  /** Request handling. Its runtime and protocol imports stay imports, so the isolate holds one record of each. */
  [ISOLATE_HANDLER_MODULE_NAME]: {
    specifier: path.join(PACKAGE_DIR, "src/isolate-entry.ts"),
    target: "browser",
    forbidNodeBuiltins: true,
    aliases: {
      [Bun.resolveSync("@pletivo/runtime/astro-shim", PACKAGE_DIR)]: "./pletivo-runtime.js",
      [Bun.resolveSync("@pletivo/core/paginate", PACKAGE_DIR)]: "./pletivo-runtime.js",
      [path.join(PACKAGE_DIR, "src/isolate-protocol.ts")]: "./pletivo-isolate-protocol.js",
    },
  },
};

/** Of those, the ones `compileProject` adds to every bundle. */
const ALWAYS_BUNDLED = ["pletivo-runtime.js", "pletivo-isolate-protocol.js"];

/** Sucrase appends `/jsx-runtime` to `jsxImportSource`; this module re-exports, it is not a second copy. */
const JSX_RUNTIME_MODULE_NAME = "pletivo-jsx-runtime.js";
const JSX_RUNTIME_MODULE =
  'export { jsx, jsxs, jsxDEV, jsxFragment as Fragment } from "./pletivo-runtime.js";\n';

/** The Loader's main module: the static entry logic, applied to the program's data module. */
const ISOLATE_ENTRY_MODULE_NAME = "pletivo-entry.js";
const ISOLATE_PROGRAM_MODULE_NAME = "pletivo-program.js";
const ISOLATE_ENTRY_MODULE = [
  `import * as program from "./${ISOLATE_PROGRAM_MODULE_NAME}";`,
  `import { createIsolateEntry } from "./${ISOLATE_HANDLER_MODULE_NAME}";`,
  "export default createIsolateEntry(program);",
  "",
].join("\n");

/** Bundle one entry point into a single self-contained module. */
export async function bundleRuntimeModule(entry: Entry): Promise<string> {
  const plugins: BunPlugin[] = [];
  const aliased = new Map<string, string>();
  if (entry.aliases) plugins.push(aliasModules(entry.aliases, aliased));
  if (entry.external?.length) plugins.push(externalizeModules(entry.external));
  if (entry.forbidNodeBuiltins) plugins.push(rejectNodeBuiltins(entry.specifier));
  const result = await Bun.build({
    entrypoints: [Bun.resolveSync(entry.specifier, PACKAGE_DIR)],
    target: entry.target,
    conditions: entry.conditions,
    plugins: plugins.length > 0 ? plugins : undefined,
    format: "esm",
    minify: false,
  });
  if (!result.success) {
    throw new Error(
      `[pletivo-workers] bundling ${entry.specifier} failed:\n${result.logs.join("\n")}`,
    );
  }
  const code = retargetImports(await result.outputs[0].text(), aliased);
  const allowed = new Set([...aliased.values(), ...(entry.external ?? [])]);
  const stray = strayImports(code, allowed, entry.target === "node");
  if (stray.length > 0) {
    throw new Error(
      `[pletivo-workers] ${entry.specifier} bundles to imports no Loader module answers: ` +
        stray.join(", "),
    );
  }
  return code;
}

interface ImportSource {
  value: string;
  start: number;
  end: number;
}

/** Every module specifier in `code`, static and dynamic. A computed `import()` is `null`. */
function importSources(code: string): (ImportSource | null)[] {
  const sources: (ImportSource | null)[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const type: unknown = Reflect.get(node, "type");
    const isImport =
      type === "ImportDeclaration" ||
      type === "ExportNamedDeclaration" ||
      type === "ExportAllDeclaration" ||
      type === "ImportExpression";
    const source: unknown = isImport ? Reflect.get(node, "source") : null;
    // `export { a }` has no source; only an `import()` can name a computed one.
    if (source !== null || type === "ImportExpression") sources.push(literalSource(source));
    for (const child of Object.values(node)) visit(child);
  };
  visit(parse(code, { ecmaVersion: "latest", sourceType: "module" }));
  return sources;
}

function literalSource(source: unknown): ImportSource | null {
  if (typeof source !== "object" || source === null) return null;
  const value: unknown = Reflect.get(source, "value");
  const start: unknown = Reflect.get(source, "start");
  const end: unknown = Reflect.get(source, "end");
  if (typeof value !== "string" || typeof start !== "number" || typeof end !== "number") {
    return null;
  }
  return { value, start, end };
}

/**
 * The imports in a generated module that no Loader module answers: anything but the
 * `allowed` names and, for a `node` bundle, Node built-ins workerd provides.
 */
export function strayImports(
  code: string,
  allowed: ReadonlySet<string>,
  nodeBuiltins: boolean,
): string[] {
  const stray: string[] = [];
  for (const source of importSources(code)) {
    if (source === null) {
      stray.push("import(<computed>)");
      continue;
    }
    if (allowed.has(source.value)) continue;
    if (nodeBuiltins && source.value.startsWith("node:")) continue;
    stray.push(source.value);
  }
  return [...new Set(stray)];
}

/** Bun keeps an external's original specifier, so aliased imports are renamed after the build. */
function retargetImports(code: string, aliased: ReadonlyMap<string, string>): string {
  if (aliased.size === 0) return code;
  const sources = importSources(code)
    .filter((source): source is ImportSource => source !== null && aliased.has(source.value))
    .sort((left, right) => right.start - left.start);
  let out = code;
  for (const source of sources) {
    out = out.slice(0, source.start) + JSON.stringify(aliased.get(source.value)) + out.slice(source.end);
  }
  return out;
}

const NODE_BUILTINS = new Set(builtinModules.map((specifier) => specifier.replace(/^node:/, "")));

function rejectNodeBuiltins(entry: string): BunPlugin {
  return {
    name: "reject-node-builtins",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (!NODE_BUILTINS.has(args.path.replace(/^node:/, ""))) return undefined;
        throw new Error(
          `[pletivo-workers] ${entry} cannot depend on Node built-in ${JSON.stringify(args.path)}`,
        );
      });
    },
  };
}

function externalizeModules(specifiers: string[]): BunPlugin {
  return {
    name: "externalize-runtime-modules",
    setup(build) {
      // A browser target replaces Node built-ins before Bun's `external` option sees
      // them. Exact hooks preserve those imports without intercepting the rest of
      // Bun's resolver graph.
      for (const specifier of specifiers) {
        const filter = new RegExp(`^${escapeRegex(specifier)}$`);
        build.onResolve({ filter }, (args) => ({ path: args.path, external: true }));
      }
    },
  };
}

/** Externalizes whatever resolves to an aliased file, recording specifier -> Loader module. */
function aliasModules(aliases: Record<string, string>, aliased: Map<string, string>): BunPlugin {
  return {
    name: "alias-runtime-modules",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        let resolved: string;
        try {
          resolved = Bun.resolveSync(args.path, path.dirname(args.importer));
        } catch {
          return undefined;
        }
        const target = aliases[resolved];
        if (target === undefined) return undefined;
        const previous = aliased.get(args.path);
        if (previous !== undefined && previous !== target) {
          throw new Error(
            `[pletivo-workers] ${JSON.stringify(args.path)} resolves to both ${previous} and ${target}`,
          );
        }
        aliased.set(args.path, target);
        return { path: args.path, external: true };
      });
    },
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function generateRuntimeModules(): Promise<string> {
  const entries: string[] = [];
  for (const [name, entry] of Object.entries(ENTRIES)) {
    const code = await bundleRuntimeModule(entry);
    entries.push(`  ${JSON.stringify(name)}: ${JSON.stringify(code)},`);
  }
  entries.push(`  ${JSON.stringify(JSX_RUNTIME_MODULE_NAME)}: ${JSON.stringify(JSX_RUNTIME_MODULE)},`);
  entries.push(`  ${JSON.stringify(ISOLATE_ENTRY_MODULE_NAME)}: ${JSON.stringify(ISOLATE_ENTRY_MODULE)},`);
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
    "/** The module `astro:assets` and an `image()` schema resolve through. Added only when reached for. */",
    'export const IMAGE_MODULE_NAME = "pletivo-image.js";',
    "",
    "/** The request parser shared by the host and the isolate entry. */",
    'export const ISOLATE_PROTOCOL_MODULE_NAME = "pletivo-isolate-protocol.js";',
    "",
    "/** The Loader's main module. Never a project path. */",
    `export const ISOLATE_ENTRY_MODULE_NAME = ${JSON.stringify(ISOLATE_ENTRY_MODULE_NAME)};`,
    "",
    "/** The per-program data module the host generates; see `IsolateProgram` in isolate-entry.ts. */",
    `export const ISOLATE_PROGRAM_MODULE_NAME = ${JSON.stringify(ISOLATE_PROGRAM_MODULE_NAME)};`,
    "",
    "/** The entry modules every Loader program carries next to its data module. */",
    "export const ISOLATE_ENTRY_MODULES: Readonly<Record<string, string>> = {",
    ...[ISOLATE_ENTRY_MODULE_NAME, ISOLATE_HANDLER_MODULE_NAME].map(
      (name) => `  ${JSON.stringify(name)}: GENERATED_MODULES[${JSON.stringify(name)}],`,
    ),
    "};",
    "",
  ].join("\n");
}

if (import.meta.main) {
  const source = await generateRuntimeModules();
  // The test calls `--stdout` in a subprocess: under `bun test`, `Bun.build` cannot
  // see `packages/core/node_modules`. The bundle embeds cwd-relative comments, so the
  // subprocess must share this working directory.
  if (process.argv[2] === "--stdout") {
    process.stdout.write(source);
  } else {
    await Bun.write(OUT_FILE, source);
    console.log(`wrote ${path.relative(process.cwd(), OUT_FILE)} (${source.length} bytes)`);
  }
}
