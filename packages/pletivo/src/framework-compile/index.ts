/**
 * The Bun host's framework compilers: one per registered renderer that needs one,
 * each loading the compiler package installed in the project.
 */
import path from "path";
import { stripQuery } from "@pletivo/core/dev-cache";
import type { BunPlugin } from "bun";
import type { AstroRendererEntry } from "@pletivo/core/astro-host/renderers";
import type { FrameworkCompileTarget, FrameworkCompiler } from "@pletivo/core/framework-compile/types";
import { loadJsxCompiler } from "./jsx";
import { loadSvelteCompiler } from "./svelte";
import { loadVueCompiler } from "./vue";

/** Renderers whose components compile through the shared JSX compiler. */
const JSX_RENDERERS = new Set(["@astrojs/preact", "@astrojs/react", "@astrojs/solid-js"]);

/**
 * Compilers for the project's renderers, in registration order; JSX ones share one compiler.
 * On the server target the JSX compiler belongs in `project-source-plugin`, not in
 * `frameworkCompilePlugin`, which would claim every project `.tsx` before pletivo's loader.
 */
export async function loadFrameworkCompilers(
  projectRoot: string,
  renderers: readonly AstroRendererEntry[],
): Promise<FrameworkCompiler[]> {
  const compilers: FrameworkCompiler[] = [];
  const names = renderers.map((r) => r.name);
  if (names.some((name) => JSX_RENDERERS.has(name))) {
    compilers.push(await loadJsxCompiler(projectRoot, names));
  }
  if (names.includes("@astrojs/svelte")) compilers.push(await loadSvelteCompiler(projectRoot));
  if (names.includes("@astrojs/vue")) compilers.push(await loadVueCompiler(projectRoot));
  return compilers;
}

export interface FrameworkCompilePluginOptions {
  compilers: readonly FrameworkCompiler[];
  target: FrameworkCompileTarget;
  /** Receives the CSS a compiled module does not import itself. */
  onCss(filename: string, css: string): void;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Bun's loaders for a file no compiler claimed; any other extension has no fallback. */
const FALLBACK_LOADERS: Readonly<Record<string, "js" | "jsx" | "ts" | "tsx">> = {
  ".js": "js",
  ".mjs": "js",
  ".jsx": "jsx",
  ".ts": "ts",
  ".mts": "ts",
  ".tsx": "tsx",
};

/**
 * A Bun plugin that compiles every file whose extension a compiler is offered. Dev's
 * `?v=N` cache-bust query is allowed and stripped. A Bun runtime plugin must return a
 * module, so a file every compiler declines is returned as written, or fails by name:
 * no later plugin sees it. Pass it the server-target compilers without the JSX one.
 */
export function frameworkCompilePlugin(options: FrameworkCompilePluginOptions): BunPlugin {
  const extensions = [...new Set(options.compilers.flatMap((c) => c.extensions))];
  return {
    name: `pletivo-framework-compile-${options.target}`,
    setup(build) {
      if (extensions.length === 0) return;
      const filter = new RegExp(`(${extensions.map(escapeRegExp).join("|")})(\\?.*)?$`);
      build.onLoad({ filter }, async (args) => {
        const filename = stripQuery(args.path);
        const extension = path.extname(filename);
        const source = await Bun.file(filename).text();
        for (const compiler of options.compilers) {
          if (!compiler.extensions.includes(extension)) continue;
          const output = await compiler.compile({ source, filename, target: options.target });
          if (!output) continue;
          if (output.css !== null) options.onCss(filename, output.css);
          return { contents: output.code, loader: output.loader };
        }
        const loader = FALLBACK_LOADERS[extension];
        if (!loader) throw new Error(`${filename}: no framework compiler accepted this file`);
        return { contents: source, loader };
      });
    },
  };
}
