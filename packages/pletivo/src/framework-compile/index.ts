/**
 * The Bun host's framework compilers: one per registered renderer that needs one,
 * each loading the compiler package installed in the project.
 */
import path from "path";
import type { BunPlugin } from "bun";
import type { AstroRendererEntry } from "@pletivo/core/astro-host/renderers";
import type { FrameworkCompileTarget, FrameworkCompiler } from "@pletivo/core/framework-compile/types";
import { loadJsxCompiler } from "./jsx";
import { loadSvelteCompiler } from "./svelte";
import { loadVueCompiler } from "./vue";

/** Renderers whose components compile through the shared JSX compiler. */
const JSX_RENDERERS = new Set(["@astrojs/preact", "@astrojs/react", "@astrojs/solid-js"]);

/** Compilers for the project's renderers, in registration order; JSX ones share one compiler. */
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

/** A Bun plugin that compiles every file whose extension a compiler is offered. */
export function frameworkCompilePlugin(options: FrameworkCompilePluginOptions): BunPlugin {
  const extensions = [...new Set(options.compilers.flatMap((c) => c.extensions))];
  return {
    name: `pletivo-framework-compile-${options.target}`,
    setup(build) {
      if (extensions.length === 0) return;
      const filter = new RegExp(`(${extensions.map(escapeRegExp).join("|")})$`);
      build.onLoad({ filter }, async (args) => {
        const extension = path.extname(args.path);
        const source = await Bun.file(args.path).text();
        for (const compiler of options.compilers) {
          if (!compiler.extensions.includes(extension)) continue;
          const output = await compiler.compile({ source, filename: args.path, target: options.target });
          if (!output) continue;
          if (output.css !== null) options.onCss(args.path, output.css);
          return { contents: output.code, loader: output.loader };
        }
        return undefined;
      });
    },
  };
}
