/**
 * TypeScript and JSX stripped in the host worker, since the Loader takes only JavaScript
 * and `.astro` frontmatter keeps its TypeScript. Sucrase, imported from the package root
 * only (its CLI entries pull Node deps); see docs/todos/016 for the size comparison.
 *
 * `keepUnusedImports` is load-bearing: the import prologue drives `collectImports`,
 * `rewriteImports` and CSS cascade order, and it keeps TS-free input byte-identical.
 */

import { transform } from "sucrase";

/**
 * The package sucrase names in its injected JSX import (with `/jsx-runtime` appended),
 * matching the Bun host's `jsxImportSource`.
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
   * Parse JSX and compile it to the automatic runtime. Off by default: `.ts` reads
   * `<T>(x) => x` as a type assertion, `.tsx` as an element.
   */
  jsx?: boolean;
}

/**
 * Remove TypeScript syntax, and compile JSX when asked, leaving everything else where it
 * was. Input with neither comes back byte-identical.
 */
export function stripTypes(code: string, options: TranspileOptions): string {
  try {
    return transform(code, {
      transforms: options.jsx ? ["typescript", "jsx"] : ["typescript"],
      jsxRuntime: "automatic",
      jsxImportSource: JSX_IMPORT_SOURCE,
      // The runtime's `jsx` and `jsxDEV` are the same function; this picks the specifier the bundle carries.
      production: true,
      keepUnusedImports: true,
      disableESTransforms: true,
      filePath: options.file,
    }).code;
  } catch (error) {
    throw new TranspileError(options.file, error);
  }
}
