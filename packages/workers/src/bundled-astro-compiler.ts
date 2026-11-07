/// <reference path="./astro-wasm.d.ts" />

/**
 * The Astro compiler bound to the `astro.wasm` this module's bundler embedded, in the
 * importing isolate. Importing this module is what puts the wasm in a host's bundle.
 */

import astroWasm from "@astrojs/compiler/astro.wasm";
import type { ParseOptions, ParseResult, TransformOptions, TransformResult } from "@astrojs/compiler/types";
import { createAstroCompiler, type AstroCompiler } from "./astro-compiler.ts";

let bundled: AstroCompiler | undefined;

/** The compiler over the embedded `astro.wasm`, started on its first call. */
export function bundledAstroCompiler(): AstroCompiler {
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
export async function compileAstro(source: string, options?: TransformOptions): Promise<TransformResult> {
  return bundledAstroCompiler().transform(source, options);
}

/** Parse one `.astro` source to an AST. Mirrors `parse()` from `@astrojs/compiler`. */
export async function parseAstro(source: string, options?: ParseOptions): Promise<ParseResult> {
  return bundledAstroCompiler().parse(source, options);
}
