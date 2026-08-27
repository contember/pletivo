/**
 * `@astrojs/compiler` inside a Worker isolate.
 *
 * The compiler is a Go program compiled to wasm. Neither of the entry points
 * the package ships works in workerd: the node one reads `astro.wasm` off the
 * filesystem, the browser one fetches it and calls `WebAssembly.compile()`,
 * which workerd forbids at runtime. What does work is instantiating a module
 * the bundler compiled ahead of time, against the vendored Go runtime.
 */

import astroWasm from "@astrojs/compiler/astro.wasm";
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
interface RawCompilerApi {
  transform(source: string, options: TransformOptions): TransformResult;
  parse(source: string, options: ParseOptions): { ast: string; diagnostics: DiagnosticMessage[] };
}

/** Promise-returning wrappers, matching what `@astrojs/compiler` exports on other hosts. */
export interface AstroCompiler {
  transform(source: string, options?: TransformOptions): Promise<TransformResult>;
  parse(source: string, options?: ParseOptions): Promise<ParseResult>;
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

function rawApi(wasm: WebAssembly.Module): RawCompilerApi {
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
      return rawApi(wasm).transform(source, options);
    },
    async parse(source, options = {}) {
      const result = rawApi(wasm).parse(source, options);
      const ast: unknown = JSON.parse(result.ast);
      if (!isRootNode(ast)) {
        throw new Error("[pletivo-workers] the Astro compiler returned an AST without a root node");
      }
      return { ast, diagnostics: result.diagnostics };
    },
  };
}

let bundled: AstroCompiler | undefined;

/** The compiler bound to the `astro.wasm` this module's bundler embedded. */
function bundledCompiler(): AstroCompiler {
  if (!bundled) {
    if (!(astroWasm instanceof WebAssembly.Module)) {
      throw new Error(
        "[pletivo-workers] `@astrojs/compiler/astro.wasm` did not resolve to a WebAssembly.Module. " +
          'Bundle it with wrangler\'s `{ "type": "CompiledWasm", "globs": ["**/*.wasm"] }` rule, ' +
          "or call createAstroCompiler() with a module you compiled yourself.",
      );
    }
    bundled = createAstroCompiler(astroWasm);
  }
  return bundled;
}

/** Compile one `.astro` source. Mirrors `transform()` from `@astrojs/compiler`. */
export async function compileAstro(
  source: string,
  options?: TransformOptions,
): Promise<TransformResult> {
  return bundledCompiler().transform(source, options);
}

/** Parse one `.astro` source to an AST. Mirrors `parse()` from `@astrojs/compiler`. */
export async function parseAstro(source: string, options?: ParseOptions): Promise<ParseResult> {
  return bundledCompiler().parse(source, options);
}
