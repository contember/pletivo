import type { Plugin } from "vite";

/**
 * Vite plugin that transforms pavouk's `client="load"` prop syntax
 * to Astro's `client:load` directive syntax.
 *
 * Runs before astro-jsx-pages so that it can detect the directives.
 */
export function pavoukCompatPlugin(): Plugin {
  return {
    name: "pavouk-compat",
    enforce: "pre",

    transform(code, id) {
      // Only process TSX/JSX files in src/pages/ or src/islands/
      if (!/\.[jt]sx$/.test(id)) return null;
      if (!code.includes('client=')) return null;

      let transformed = code;

      // client="load" → client:load
      transformed = transformed.replace(
        /\bclient="load"/g,
        "client:load",
      );

      // client="idle" → client:idle
      transformed = transformed.replace(
        /\bclient="idle"/g,
        "client:idle",
      );

      // client="visible" → client:visible
      transformed = transformed.replace(
        /\bclient="visible"/g,
        "client:visible",
      );

      // client="media(...)" → client:media="..."
      transformed = transformed.replace(
        /\bclient="media\(([^)]+)\)"/g,
        'client:media="$1"',
      );

      if (transformed === code) return null;

      return {
        code: transformed,
        map: null,
      };
    },
  };
}
