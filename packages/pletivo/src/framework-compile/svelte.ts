import type { FrameworkCompiler } from "@pletivo/core/framework-compile/types";

/** `.svelte` through the project's `svelte/compiler`, with its `svelte.config.*` preprocessors. */
export async function loadSvelteCompiler(projectRoot: string): Promise<FrameworkCompiler> {
  throw new Error(`Svelte compiler is not implemented yet (${projectRoot})`);
}
