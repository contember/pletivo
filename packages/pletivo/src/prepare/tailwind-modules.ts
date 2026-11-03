/**
 * Tailwind `@plugin` and `@config` targets, frozen into the artifact. Tailwind calls a
 * plugin synchronously while it compiles, so the Workers host runs it in the isolate
 * next to Tailwind itself. A plugin is usually CommonJS (`module.exports`, `require()`),
 * which the artifact's module graph cannot carry, so each one is bundled here into a
 * single ES module whose default export is the value Tailwind's Node loader would get.
 */

import { builtinModules } from "node:module";
import type { BunPlugin } from "bun";

const ENTRY = "pletivo-tailwind-module";
const ENTRY_NAMESPACE = "pletivo-tailwind-module";
const NODE_BUILTINS = new Set(builtinModules.map((specifier) => specifier.replace(/^node:/, "")));

/** Why a Tailwind module could not be bundled for the Workers host. */
export class TailwindModuleBundleError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "TailwindModuleBundleError";
  }
}

/** Bundle the module at `file` and everything it requires into one self-contained ES module. */
export async function bundleTailwindModule(file: string): Promise<string> {
  const builtins = new Set<string>();
  let result: Awaited<ReturnType<typeof Bun.build>>;
  try {
    result = await Bun.build({
      entrypoints: [ENTRY],
      // `browser`, not `node`: Bun's Node interop for CommonJS calls
      // `createRequire(import.meta.url)`, and a Loader module has no `import.meta.url`.
      target: "browser",
      // What Tailwind's own Node loader resolves a plugin's dependencies with.
      conditions: ["node", "require"],
      format: "esm",
      // Whitespace only, which also drops the `// <path>` comments Bun writes relative to the
      // working directory: the module id is the digest of these bytes.
      minify: { whitespace: true, syntax: false, identifiers: false },
      // The browser target inlines CommonJS `__dirname` and `__filename` as absolute paths.
      define: { __dirname: JSON.stringify("/"), __filename: JSON.stringify("/index.js") },
      plugins: [entryWrapper(file), rejectNodeBuiltins(builtins)],
    });
  } catch (error) {
    throw bundleError(builtins, error instanceof Error ? error.message : String(error));
  }
  if (!result.success) throw bundleError(builtins, result.logs.map(String).join("\n"));
  const [output] = result.outputs;
  if (output === undefined || result.outputs.length !== 1) {
    throw new TailwindModuleBundleError(`bundling produced ${result.outputs.length} files instead of one`);
  }
  return output.text();
}

function bundleError(builtins: ReadonlySet<string>, detail: string): TailwindModuleBundleError {
  if (builtins.size > 0) {
    return new TailwindModuleBundleError(
      `it requires the Node built-in ${[...builtins].map((name) => JSON.stringify(name)).join(", ")}, ` +
        "which the Workers host does not provide",
    );
  }
  return new TailwindModuleBundleError(`bundling failed: ${detail}`);
}

/**
 * `module.exports` of a CommonJS module, or the default export of an ES one. A CommonJS module
 * compiled from ESM (`__esModule`) gives its `default`, as Bun's and a bundler's import would.
 */
function entryWrapper(file: string): BunPlugin {
  return {
    name: "pletivo-tailwind-module-entry",
    setup(build) {
      build.onResolve({ filter: new RegExp(`^${ENTRY}$`) }, () => ({ path: ENTRY, namespace: ENTRY_NAMESPACE }));
      build.onLoad({ filter: /.*/, namespace: ENTRY_NAMESPACE }, () => ({
        contents:
          `import * as loaded from ${JSON.stringify(file)};\n` +
          `const value = "default" in loaded ? loaded.default : loaded;\n` +
          `export default (value !== null && typeof value === "object" && value.__esModule === true && "default" in value\n` +
          `  ? value.default\n` +
          `  : value);\n`,
        loader: "js",
      }));
    },
  };
}

function rejectNodeBuiltins(found: Set<string>): BunPlugin {
  return {
    name: "pletivo-tailwind-module-builtins",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        const name = args.path.replace(/^node:/, "");
        if (!NODE_BUILTINS.has(name)) return undefined;
        found.add(args.path);
        throw new TailwindModuleBundleError(`Node built-in ${JSON.stringify(args.path)}`);
      });
    },
  };
}
