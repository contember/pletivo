/**
 * Rewrites the import specifiers in compiled `.astro` output.
 *
 * `@astrojs/compiler` leaves user imports exactly as written — `resolvePath` is
 * only consulted for the component paths behind client directives, so frontmatter
 * imports come out of `transform()` still pointing at `../components/Layout.astro`.
 * On the Bun host the loader resolves those against the filesystem. A Worker has no
 * filesystem: every module has to be named in the bundle handed to the isolate, so
 * the host rewrites the specifiers itself. This is that seam.
 *
 * `collectSpecifiers` reads the same imports without rewriting them, so the module
 * graph the bundle is assembled from and the graph the CSS cascade is ordered by are
 * the same graph, seen the same way.
 */

/**
 * Resolves one specifier found in `code`.
 *
 * @param resolved  a relative specifier joined onto the importer's directory,
 *                  or a bare/absolute specifier unchanged
 * @param specifier the specifier exactly as written
 * @returns the specifier to emit, or `null` to leave the import alone
 */
export type ResolveImport = (resolved: string, specifier: string) => string | null;

export interface RewriteImportsOptions {
  /** Path of the module being rewritten. Relative specifiers resolve against its directory. */
  importer: string;
  resolve: ResolveImport;
}

/** `import ... from "x"` / `export ... from "x"`. The body may span lines but not a quote or `;`. */
const FROM_IMPORT = /((?:import|export)\b[^'"`;]*?\bfrom\s*)(["'])([^"']+)\2/g;

/** `import "x"` — a side-effect import, which the `from` form cannot match. */
const BARE_IMPORT = /(\bimport\s*)(["'])([^"']+)\2/g;

/** `import("x")`. Searched everywhere: it can legitimately sit inside a function body. */
const DYNAMIC_IMPORT = /(\bimport\s*\(\s*)(["'])([^"']+)\2(\s*\))/g;

/** Whitespace, a line comment, or a block comment. */
const PROLOGUE_TRIVIA = /(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)/y;
const PROLOGUE_FROM = /(?:import|export)\b[^'"`;]*?\bfrom\s*(["'])[^"']+\1[ \t]*;?/y;
const PROLOGUE_BARE = /import\s*(["'])[^"']+\1[ \t]*;?/y;

/**
 * End of the run of import/export statements the module opens with.
 *
 * Static imports are only rewritten below this offset, because everything the
 * compiler puts above it is a statement and everything below it may be page text.
 * `@astrojs/compiler` hoists frontmatter imports out of the component factory, so
 * for its output the boundary is exact — and it has to be: a page whose body shows
 * `import Layout from "../layouts/Layout.astro"` in a code block emits that line at
 * column 0 inside a template literal, where a line-anchored pattern cannot tell it
 * apart from the real import.
 *
 * An import placed after other statements is left alone. That is a missing module
 * at bundle time — loud — rather than a rewritten line of page copy.
 */
export function prologueEnd(code: string): number {
  return walkPrologue(code);
}

/** Walk the prologue, handing each import/export statement's text to `onStatement`. */
function walkPrologue(code: string, onStatement?: (statement: string) => void): number {
  let index = 0;
  for (;;) {
    const advanced = [PROLOGUE_TRIVIA, PROLOGUE_FROM, PROLOGUE_BARE].some((pattern) => {
      pattern.lastIndex = index;
      if (!pattern.test(code)) return false;
      if (pattern !== PROLOGUE_TRIVIA) onStatement?.(code.slice(index, pattern.lastIndex));
      index = pattern.lastIndex;
      return true;
    });
    if (!advanced) return index;
  }
}

/** The first quoted run in an import statement is its specifier. */
const STATEMENT_SPECIFIER = /(["'])([^"']+)\1/;

/**
 * Every specifier the module imports, within the same bounds `rewriteImports` uses.
 *
 * Prologue imports come first in source order, then dynamic `import()` from anywhere.
 * That is the order Astro executes a module's imports in, and therefore the order its
 * CSS cascades in — `astro-css-order.ts` on the Bun host splits the same two groups
 * the same way.
 */
export function collectSpecifiers(code: string): string[] {
  const specifiers: string[] = [];
  walkPrologue(code, (statement) => {
    const match = STATEMENT_SPECIFIER.exec(statement);
    if (match) specifiers.push(match[2]);
  });
  for (const match of code.matchAll(DYNAMIC_IMPORT)) specifiers.push(match[3]);
  return specifiers;
}

/**
 * Join a relative specifier onto the importer's directory. Bare and absolute
 * specifiers are returned unchanged — there is no node_modules to walk here.
 *
 * A `..` that climbs past the root is dropped, so an importer given with the wrong
 * prefix yields a path no project file matches; `resolve` then leaves the import
 * alone and the bundle reports it.
 */
export function resolveSpecifier(importer: string, specifier: string): string {
  if (!specifier.startsWith(".")) return specifier;
  const segments = importer.split("/").slice(0, -1).concat(specifier.split("/"));
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  return out.join("/");
}

export function rewriteImports(code: string, options: RewriteImportsOptions): string {
  const { importer, resolve } = options;
  const replace = (match: string, prefix: string, quote: string, specifier: string, suffix = "") => {
    const target = resolve(resolveSpecifier(importer, specifier), specifier);
    return target === null ? match : `${prefix}${quote}${target}${quote}${suffix}`;
  };
  const staticOnly = (source: string) =>
    source
      .replace(FROM_IMPORT, (match, prefix, quote, specifier) =>
        replace(match, prefix, quote, specifier),
      )
      .replace(BARE_IMPORT, (match, prefix, quote, specifier) =>
        replace(match, prefix, quote, specifier),
      );

  const end = prologueEnd(code);
  return (staticOnly(code.slice(0, end)) + code.slice(end)).replace(DYNAMIC_IMPORT, replace);
}
