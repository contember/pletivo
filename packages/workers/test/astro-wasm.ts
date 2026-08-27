import path from "node:path";

/**
 * One `WebAssembly.Module` per process, shared by every test file: the Go program
 * owns a single `globalThis` slot, so `createAstroCompiler` refuses a second one.
 */
let module: Promise<WebAssembly.Module> | undefined;

export function astroWasmModule(): Promise<WebAssembly.Module> {
  module ??= compile();
  return module;
}

/** A distinct module, for asserting that the isolate refuses to run two compilers. */
export async function compile(): Promise<WebAssembly.Module> {
  const wasmPath = path.join(
    path.dirname(Bun.resolveSync("@astrojs/compiler/package.json", import.meta.dir)),
    "dist/astro.wasm",
  );
  return new WebAssembly.Module(await Bun.file(wasmPath).arrayBuffer());
}
