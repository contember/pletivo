import type { FrameworkCompiler } from "@pletivo/core/framework-compile/types";
import { createVueCompiler, type VueSfcCompiler } from "@pletivo/core/framework-compile/vue";

/**
 * `.vue` single-file components through the project's `vue/compiler-sfc`, the entry
 * @astrojs/vue compiles with. It matches the installed Vue runtime; a direct
 * `@vue/compiler-sfc` can resolve to another copy.
 */
export async function loadVueCompiler(projectRoot: string): Promise<FrameworkCompiler> {
  let entry: string;
  try {
    entry = Bun.resolveSync("vue/compiler-sfc", projectRoot);
  } catch (error) {
    throw new Error(`@astrojs/vue is registered, but vue/compiler-sfc cannot be resolved from ${projectRoot}. Is vue installed?`, {
      cause: error,
    });
  }
  const loaded: unknown = await import(entry);
  if (!isVueSfcCompiler(loaded)) {
    throw new Error(`${entry} does not export Vue's SFC compiler (version, parse, compileScript, compileTemplate, compileStyle).`);
  }
  return createVueCompiler(loaded, { root: projectRoot });
}

function isVueSfcCompiler(value: unknown): value is VueSfcCompiler {
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    typeof value.version === "string" &&
    "parse" in value &&
    typeof value.parse === "function" &&
    "compileScript" in value &&
    typeof value.compileScript === "function" &&
    "compileTemplate" in value &&
    typeof value.compileTemplate === "function" &&
    "compileStyle" in value &&
    typeof value.compileStyle === "function"
  );
}
