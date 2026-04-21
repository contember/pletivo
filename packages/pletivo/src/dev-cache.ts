/**
 * Dev-mode module cache busting.
 *
 * Bun's ESM loader caches modules by specifier. When the dev server
 * re-imports a page after a file change, only the top-level specifier
 * changes — transitive imports (child components, stylesheets, JSON
 * dictionaries) stay cached and editing them appears to do nothing.
 *
 * We sidestep this by appending `?v=<devVersion>` to rewritable import
 * specifiers in compiled output. The dev server bumps `devVersion` on
 * every file change, which forces Bun to re-fetch each transitive
 * import the next time a page is rendered.
 */

/**
 * Strip the `?...` suffix Bun passes through to `onLoad` handlers so
 * the clean path can be used for filesystem reads. Handles both the
 * `?v=N` cache-buster this module appends and Vite-style `?raw`/`?inline`.
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
 * No-op until the dev server first bumps the version (builds stay at 0),
 * so production output is never rewritten.
 */
export function applyDevCacheBust(code: string, version: number): string {
  if (version <= 0) return code;
  return code
    .replace(/(from\s+['"])([^'"]+\.astro)(['"])/g, `$1$2?v=${version}$3`)
    // Side-effect imports `import '../foo.scss'` (no `from`)
    .replace(/(import\s+['"])([^'"]+\.(?:scss|sass))(['"])/g, `$1$2?v=${version}$3`)
    // Data-file imports (e.g. `import cs from '../i18n/cs.json'`)
    .replace(/(from\s+['"])([^'"]+\.json)(['"])/g, `$1$2?v=${version}$3`);
}
