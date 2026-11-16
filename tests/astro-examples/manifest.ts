/**
 * Which of Astro's official examples the compatibility harness builds.
 *
 * Every directory under `examples/` at `ASTRO_REF` is built unless it is listed
 * in `SKIPPED`, so an example added upstream shows up in the table on its own.
 */

export const ASTRO_REPO = "https://github.com/withastro/astro.git";
/** The examples' `package.json` files name this astro version. */
export const ASTRO_REF = "astro@5.16.11";

/** Examples that are not static sites pletivo could build, with the reason. */
export const SKIPPED: Record<string, string> = {
  hackernews: "SSR only: `output: 'server'` with the @astrojs/node adapter",
  ssr: "SSR only: `output: 'server'` with the @astrojs/node adapter",
  component: "a component package, not a site",
  integration: "an integration package, not a site",
  "toolbar-app": "a dev toolbar app, not a site",
};
