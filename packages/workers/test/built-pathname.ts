/**
 * The URL a file `pletivo build` wrote is served at.
 *
 * Shared by the two parity harnesses, which must ask the Workers host for the same
 * URL the Bun host thought it was rendering — `build.ts:toPathname` is what fed
 * `Astro.url` there, trailing slash and all, so a page that prints its own pathname
 * would otherwise diverge for no reason but the harness.
 */
export function builtPathname(outputPath: string): string {
  const INDEX = "index.html";
  return "/" + (outputPath.endsWith(INDEX) ? outputPath.slice(0, -INDEX.length) : outputPath);
}
