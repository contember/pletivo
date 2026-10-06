/**
 * Bundlers disagree on what a `.wasm` import yields: wrangler's `CompiledWasm`
 * rule hands over a compiled `WebAssembly.Module`, Bun's loader hands over the
 * file path. Only the first form is usable in workerd — see `astro-compiler.ts`.
 */
declare module "@astrojs/compiler/astro.wasm" {
  const astroWasm: WebAssembly.Module | string;
  export default astroWasm;
}
