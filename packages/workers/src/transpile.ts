/**
 * TypeScript and JSX out of a module, in the host worker.
 *
 * `@astrojs/compiler` copies `.astro` frontmatter into its output verbatim, so
 * `export interface Props` — the documented Astro idiom — arrives at the Worker
 * Loader as JavaScript that does not parse. The Loader takes JavaScript and
 * workerd has no `eval`, so the strip has to happen out here, in the host worker,
 * whose own bundler compiled this file at build time. The same seam compiles
 * `.tsx` pages, which need JSX on top of the same parse.
 *
 * ## Why sucrase
 *
 * It is the only stripper that fits a Worker bundle. Measured, `bun build
 * --target=node --minify` then gzipped: `ts-blank-space` is 1.01 MB gzipped
 * because it depends on the whole `typescript` package; sucrase is 62 KB.
 *
 * Import the package root and nothing else. `sucrase/dist/cli` and
 * `sucrase/dist/register` reach for `mz`, `pirates`, `commander` and
 * `tinyglobby`, none of which run in an isolate — the root entry
 * (`dist/esm/index.js` via the `module` field) imports none of them, and
 * `test/transpile.test.ts` holds that line.
 *
 * ## Why these options
 *
 * - `keepUnusedImports` — the transform must not touch the module graph.
 *   `collectSpecifiers`, `rewriteImports` and the CSS cascade order all read the
 *   import prologue, so an elided import would silently move a page's styles.
 *   It also buys a much stronger property: a module with no TypeScript in it
 *   comes back byte-identical, so wiring this in cannot disturb anything that
 *   already rendered. Explicit `import type` still goes, which is correct — it
 *   never was an edge.
 * - `disableESTransforms` — optional chaining, class fields and friends are
 *   syntax V8 has had for years. Downlevelling them would only move the output
 *   further from what the Bun host runs.
 */

import { transform } from "sucrase";

/**
 * The package sucrase names in the import it injects for JSX. It appends
 * `/jsx-runtime`, so a page compiles to `import { jsx } from "pletivo/jsx-runtime"`
 * — the same specifier the Bun host's transpiler emits, from the same
 * `jsxImportSource`. `compileProject` points it at the bundle's copy.
 */
export const JSX_IMPORT_SOURCE = "pletivo";

/** What the injected JSX import resolves to, before the bundle renames it. */
export const JSX_IMPORT_SPECIFIER = `${JSX_IMPORT_SOURCE}/jsx-runtime`;

/** A module sucrase could not parse, named. */
export class TranspileError extends Error {
  constructor(
    readonly file: string,
    readonly cause: unknown,
  ) {
    super(
      `[pletivo-workers] could not transpile ${JSON.stringify(file)}: ` +
        (cause instanceof Error ? cause.message : String(cause)),
    );
    this.name = "TranspileError";
  }
}

export interface TranspileOptions {
  /** Project path. Only used to name the file in an error. */
  file: string;
  /**
   * Parse JSX and compile it to the automatic runtime. Off by default: a `.ts` file
   * reads `<T>(x) => x` as a type assertion, and a `.tsx` file reads it as an
   * element, so the two cannot share one parse.
   */
  jsx?: boolean;
}

/**
 * Remove TypeScript syntax — and compile JSX when asked — leaving everything else
 * where it was.
 *
 * Byte-identical output for input that carries neither — see the note above.
 */
export function stripTypes(code: string, options: TranspileOptions): string {
  try {
    return transform(code, {
      transforms: options.jsx ? ["typescript", "jsx"] : ["typescript"],
      jsxRuntime: "automatic",
      jsxImportSource: JSX_IMPORT_SOURCE,
      // `jsx`, `jsxs` and `jsxDEV` are the same function in @pletivo/runtime, so the
      // two modes differ only in which specifier is imported. Pick the one the
      // bundle actually carries.
      production: true,
      keepUnusedImports: true,
      disableESTransforms: true,
      filePath: options.file,
    }).code;
  } catch (error) {
    throw new TranspileError(options.file, error);
  }
}
