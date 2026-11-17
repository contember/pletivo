import type { FrameworkCompiler } from "@pletivo/core/framework-compile/types";

/** `.vue` single-file components through the project's `@vue/compiler-sfc`. */
export async function loadVueCompiler(projectRoot: string): Promise<FrameworkCompiler> {
  throw new Error(`Vue compiler is not implemented yet (${projectRoot})`);
}
