/**
 * Compiling a framework's source files (`.svelte`, `.vue`, JSX for Preact, React or
 * Solid) for the server render or the browser. Each compiler wraps the project's own
 * compiler package, which the host loads and passes in; core imports none of them.
 */

/** `server`: imported by the page render. `client`: bundled for hydration in the browser. */
export type FrameworkCompileTarget = "server" | "client";

export interface FrameworkCompileInput {
  /** The file's text as read from disk. */
  source: string;
  /** Absolute path. */
  filename: string;
  target: FrameworkCompileTarget;
}

export interface FrameworkCompileOutput {
  /** Module source in the language `loader` names, for Bun to finish. */
  code: string;
  loader: "js" | "jsx" | "ts" | "tsx";
  /** Component CSS the module does not import itself, or `null`. The host adds it to the page. */
  css: string | null;
}

export interface FrameworkCompiler {
  /** For messages, e.g. `Svelte`. */
  framework: string;
  /**
   * Filename suffixes this compiler is offered, e.g. `[".svelte", ".svelte.js"]`. A file goes
   * to the compilers of its longest matching suffix (`offeredSuffix`), so `.svelte.js` wins over `.js`.
   */
  extensions: readonly string[];
  /** `null` when the file is not this compiler's, e.g. a `.tsx` written for pletivo's own JSX. */
  compile(input: FrameworkCompileInput): Promise<FrameworkCompileOutput | null>;
}

/** The longest of `suffixes` that `filename` ends with, or `null`. Case-sensitive, as Vite's plugin filters are. */
export function offeredSuffix(filename: string, suffixes: Iterable<string>): string | null {
  let longest: string | null = null;
  for (const suffix of suffixes) {
    if (filename.endsWith(suffix) && (longest === null || suffix.length > longest.length)) longest = suffix;
  }
  return longest;
}
