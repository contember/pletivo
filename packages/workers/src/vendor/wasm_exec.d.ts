/** Hand-written types for the vendored Go runtime. Upstream ships `sp: any` everywhere. */
declare class Go {
  /** Passed straight to `new WebAssembly.Instance`; the Go runtime owns its shape. */
  readonly importObject: WebAssembly.Imports;
  /** Resolves when the Go program exits — never awaited, `main()` parks after publishing its API. */
  run(instance: WebAssembly.Instance): Promise<void>;
}

// The bundled chunk exports the class under its minified name.
export { Go as a };
