import type { BunPlugin } from "bun";

/**
 * Minify a finished stylesheet.
 *
 * Bun has no standalone CSS transform API, so this runs the text through
 * `Bun.build` as a virtual `.css` entrypoint. Every import the text makes
 * — `@import` targets and `url()` tokens alike — is marked external, so
 * the pass is a pure text transform: nothing is resolved, inlined or
 * expanded, and the output differs from the input only in whitespace and
 * value shorthands. Failure is not fatal; the unminified CSS still works.
 */

const ENTRY_PREFIX = "pletivo:css-minify:";
const VIRTUAL_DIR = "/pletivo-css-minify/";

const pending = new Map<string, string>();
let counter = 0;

export async function minifyCss(css: string): Promise<string> {
  if (!css.trim()) return css;

  const token = `t${counter++}`;
  pending.set(token, css);
  try {
    const result = await Bun.build({
      entrypoints: [ENTRY_PREFIX + token],
      target: "browser",
      minify: true,
      plugins: [minifyBunPlugin()],
    });
    if (!result.success) {
      console.warn(
        `[pletivo] CSS minification failed, emitting unminified:\n${result.logs.map(String).join("\n")}`,
      );
      return css;
    }
    for (const output of result.outputs) {
      if (output.type?.includes("text/css") || output.path.endsWith(".css")) {
        return await output.text();
      }
    }
    return css;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[pletivo] CSS minification failed, emitting unminified: ${message}`);
    return css;
  } finally {
    pending.delete(token);
  }
}

function minifyBunPlugin(): BunPlugin {
  const entryFilter = new RegExp(`^${ENTRY_PREFIX}`);
  const virtualFilter = new RegExp(`^${VIRTUAL_DIR}.*\\.css$`);

  return {
    name: "pletivo-css-minify",
    setup(build) {
      build.onResolve({ filter: entryFilter }, (args) => ({
        path: `${VIRTUAL_DIR}${args.path.slice(ENTRY_PREFIX.length)}.css`,
      }));
      build.onLoad({ filter: virtualFilter }, (args) => {
        const token = args.path.slice(VIRTUAL_DIR.length, -".css".length);
        const contents = pending.get(token);
        return contents === undefined ? undefined : { contents, loader: "css" };
      });
      // Everything the sheet references stays a reference. Registered
      // last so the entry resolver above wins for the entrypoint itself.
      build.onResolve({ filter: /.*/ }, (args) => ({ path: args.path, external: true }));
    },
  };
}
