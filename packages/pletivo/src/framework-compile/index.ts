/**
 * The Bun host's framework compilers: one per registered renderer that needs one,
 * each loading the compiler package installed in the project.
 */
import path from "path";
import { applyDevCacheBust, getDevVersion, stripQuery } from "@pletivo/core/dev-cache";
import type { BunPlugin } from "bun";
import type { AstroRendererEntry } from "@pletivo/core/astro-host/renderers";
import { offeredSuffix, type FrameworkCompileTarget, type FrameworkCompiler } from "@pletivo/core/framework-compile/types";
import { isProjectSourceFile } from "../project-source-plugin";
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
  /** Registered with `Bun.plugin`, so dev's `?v=N` cache-bust applies to project source; `Bun.build` cannot resolve it. */
  loadedByRuntime: boolean;
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
 * Compiles a file with the compilers of its longest offered suffix, in order; one every compiler
 * declines loads as written, by its real extension, or fails by name. Not for the JSX compiler.
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
        const suffix = offeredSuffix(filename, extensions);
        const source = await Bun.file(filename).text();
        // Project source only, as `project-source-plugin` busts: a library's `./store.js?v=N` is a second instance.
        const bust = (code: string) =>
          options.loadedByRuntime && isProjectSourceFile(filename) ? applyDevCacheBust(code, getDevVersion()) : code;
        for (const compiler of options.compilers) {
          if (suffix === null || !compiler.extensions.includes(suffix)) continue;
          const output = await compiler.compile({ source, filename, target: options.target });
          if (!output) continue;
          if (output.css !== null) options.onCss(filename, output.css);
          return { contents: bust(output.code), loader: output.loader };
        }
        // A Bun runtime plugin must return a module: no later plugin sees this file.
        const loader = FALLBACK_LOADERS[path.extname(filename)];
        if (!loader) throw new Error(`${filename}: no framework compiler accepted this file`);
        return { contents: bust(source), loader };
      });
    },
  };
}
