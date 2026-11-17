import type { FrameworkCompiler } from "@pletivo/core/framework-compile/types";

/**
 * JSX for Preact, React and Solid. Which framework a file belongs to comes from its
 * `@jsxImportSource` pragma, then the nearest tsconfig, as for Bun's own JSX.
 * `rendererNames` are the project's registered renderers, in order.
 */
export async function loadJsxCompiler(projectRoot: string, rendererNames: readonly string[]): Promise<FrameworkCompiler> {
  throw new Error(`JSX framework compiler is not implemented yet (${projectRoot}: ${rendererNames.join(", ")})`);
}
