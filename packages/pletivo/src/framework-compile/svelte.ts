import { existsSync } from "fs";
import path from "path";
import { pathToFileURL } from "url";
import {
  createSvelteCompiler,
  parseSvelteCompilerModule,
  parseSvelteConfig,
  type SvelteConfig,
} from "@pletivo/core/framework-compile/svelte";
import type { FrameworkCompiler } from "@pletivo/core/framework-compile/types";

/** Looked up in this order in the project root, as the Vite plugin does (minus `.cjs`). */
export const SVELTE_CONFIG_NAMES = ["svelte.config.js", "svelte.config.mjs"];

/** The project's `svelte.config.*`, as the compiler loads it, or `null`. */
export function findSvelteConfig(projectRoot: string): string | null {
  return SVELTE_CONFIG_NAMES.map((name) => path.join(projectRoot, name)).find((candidate) => existsSync(candidate)) ?? null;
}

async function loadSvelteConfig(projectRoot: string): Promise<SvelteConfig> {
  const file = findSvelteConfig(projectRoot);
  if (!file) return { preprocess: null, compilerOptions: {} };
  let mod: unknown;
  try {
    mod = await import(pathToFileURL(file).href);
  } catch (error) {
    throw new Error(`Failed to load ${file} - ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const config = typeof mod === "object" && mod !== null && "default" in mod ? mod.default : null;
  return parseSvelteConfig(config, file);
}

/** `.svelte` and Svelte modules through the project's `svelte/compiler`, with its `svelte.config.*` preprocessors. */
export async function loadSvelteCompiler(projectRoot: string): Promise<FrameworkCompiler> {
  let compilerPath: string;
  try {
    compilerPath = Bun.resolveSync("svelte/compiler", projectRoot);
  } catch (error) {
    throw new Error(`@astrojs/svelte is registered but svelte/compiler cannot be resolved from ${projectRoot}`, {
      cause: error,
    });
  }
  const compilerModule: unknown = await import(compilerPath);
  const typescript = new Bun.Transpiler({ loader: "ts" });
  return createSvelteCompiler({
    compiler: parseSvelteCompilerModule(compilerModule),
    config: await loadSvelteConfig(projectRoot),
    projectRoot,
    stripTypes: (source) => typescript.transformSync(source),
  });
}
