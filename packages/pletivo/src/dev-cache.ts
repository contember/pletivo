/**
 * Dev-mode module cache busting.
 *
 * Bun's ESM loader caches modules by specifier. Without busting, editing
 * a transitive file (child component, stylesheet, JSON dictionary) after
 * a page first renders leaves the cached copy in the graph and the edit
 * appears to do nothing. Appending `?v=<version>` to every rewritable
 * specifier forces Bun to re-fetch them on the next render.
 */

export function stripQuery(specifier: string): string {
  return specifier.replace(/\?.*$/, "");
}

let devVersion = 0;

export function bumpDevVersion(): number {
  return ++devVersion;
}

export function getDevVersion(): number {
  return devVersion;
}

/**
 * Append `?v=<version>` to every relative import specifier — static `from`,
 * side-effect `import`, and dynamic `import('./foo')` with a literal string.
 *
 * Bare specifiers (`'preact'`, `'bun:test'`) and non-literal dynamic imports
 * (`import(path)`, template literals) are left alone.
 *
 * No-op at version 0 so production builds are never rewritten.
 */
export function applyDevCacheBust(code: string, version: number): string {
  if (version <= 0) return code;
  return code.replace(
    /(\bfrom\s+['"]|\bimport\s*\(?\s*['"])(\.{1,2}\/[^'"?]+)(['"])/g,
    `$1$2?v=${version}$3`,
  );
}
