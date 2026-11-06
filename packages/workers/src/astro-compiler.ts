/**
 * `@astrojs/compiler` inside a Worker isolate. workerd forbids runtime
 * `WebAssembly.compile()`, so the Go wasm is a module the bundler compiled ahead of time,
 * run against the vendored Go runtime. Nothing here imports `astro.wasm`: a host that
 * compiles elsewhere (`compiler-isolate.ts`) never loads it. The embedded one is
 * `bundled-astro-compiler.ts`.
 */

import type {
  DiagnosticMessage,
  ParseOptions,
  ParseResult,
  RootNode,
  TransformOptions,
  TransformResult,
} from "@astrojs/compiler/types";
import { a as Go } from "./vendor/wasm_exec.js";

/** Where the Go program publishes its API once `main()` has run. */
const GLOBAL_KEY = "@astrojs/compiler";

/** The synchronous surface the Go program exposes. `parse` returns its AST as JSON text. */
export interface RawCompilerApi {
  transform(source: string, options: TransformOptions): TransformResult;
  parse(source: string, options: ParseOptions): { ast: string; diagnostics: DiagnosticMessage[] };
}

/**
 * The transform options a compiler takes: data only, so a compiler in another isolate
 * takes the same. Pletivo resolves imports itself, so every implementation passes an
 * identity `resolvePath`; without one the compiler emits its own `$$createMetadata`.
 */
export type AstroTransformOptions = Omit<TransformOptions, "resolvePath" | "preprocessStyle">;

/** Promise-returning wrappers, matching what `@astrojs/compiler` exports on other hosts. */
export interface AstroCompiler {
  transform(source: string, options?: AstroTransformOptions): Promise<TransformResult>;
  parse(source: string, options?: ParseOptions): Promise<ParseResult>;
}

/** The transform options the Go program is called with. See `AstroTransformOptions`. */
export function goTransformOptions(options: AstroTransformOptions): TransformOptions {
  return { ...options, resolvePath: async (specifier) => specifier };
}

function isRawCompilerApi(value: unknown): value is RawCompilerApi {
  if (typeof value !== "object" || value === null) return false;
  return (
    typeof Reflect.get(value, "transform") === "function" &&
    typeof Reflect.get(value, "parse") === "function"
  );
}

function isRootNode(value: unknown): value is RootNode {
  return typeof value === "object" && value !== null && Reflect.get(value, "type") === "root";
}

/**
 * The running Go program. There is one `globalThis["@astrojs/compiler"]` slot per
 * isolate, so a second instance would silently replace the first.
 */
let started: { wasm: WebAssembly.Module; api: RawCompilerApi } | undefined;

export function rawApi(wasm: WebAssembly.Module): RawCompilerApi {
  if (started) {
    if (started.wasm !== wasm) {
      throw new Error(
        "[pletivo-workers] the Astro compiler is already running in this isolate from a different WebAssembly.Module",
      );
    }
    return started.api;
  }

  const go = new Go();
  // Not awaited: `main()` publishes the API and then parks forever.
  void go.run(new WebAssembly.Instance(wasm, go.importObject));

  const api: unknown = Reflect.get(globalThis, GLOBAL_KEY);
  if (!isRawCompilerApi(api)) {
    throw new Error(
      `[pletivo-workers] the Astro compiler did not publish globalThis[${JSON.stringify(GLOBAL_KEY)}]`,
    );
  }
  started = { wasm, api };
  return api;
}

/**
 * Bind the compiler to a module the caller compiled. Instantiation is deferred to
 * the first call: the Go runtime reads `crypto.getRandomValues` during init, which
 * workerd only allows inside a request.
 */
export function createAstroCompiler(wasm: WebAssembly.Module): AstroCompiler {
  return {
    async transform(source, options = {}) {
      return rawApi(wasm).transform(source, goTransformOptions(options));
    },
    async parse(source, options = {}) {
      const result = rawApi(wasm).parse(source, options);
      return { ast: astFromJson(result.ast), diagnostics: result.diagnostics };
    },
  };
}

/** The AST the Go program hands over as JSON text. */
export function astFromJson(json: string): RootNode {
  const ast: unknown = JSON.parse(json);
  if (!isRootNode(ast)) {
    throw new Error("[pletivo-workers] the Astro compiler returned an AST without a root node");
  }
  return ast;
}
