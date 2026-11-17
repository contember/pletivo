import path from "path";
import { createJsxCompiler, type SolidTransform } from "@pletivo/core/framework-compile/jsx";
import type { FrameworkCompiler } from "@pletivo/core/framework-compile/types";
import { nearestTsconfig } from "../framework-components";

/**
 * JSX for Preact, React and Solid. Which framework a file belongs to comes from its
 * `@jsxImportSource` pragma, then the nearest tsconfig, as for Bun's own JSX.
 * `rendererNames` are the project's registered renderers, in order.
 */
export async function loadJsxCompiler(projectRoot: string, rendererNames: readonly string[]): Promise<FrameworkCompiler> {
  const transformSolid = rendererNames.includes("@astrojs/solid-js") ? await loadSolidTransform(projectRoot) : null;
  return createJsxCompiler(rendererNames, {
    tsconfigJsxImportSource: (filename) => nearestTsconfig(path.dirname(filename))?.value ?? null,
    transformSolid,
  });
}

type TransformAsync = (source: string, options: Record<string, unknown>) => Promise<unknown>;

/**
 * Babel with `babel-preset-solid`, both as `vite-plugin-solid` gets them: resolved along
 * `@astrojs/solid-js` → `vite-plugin-solid`, since an isolated install does not hoist them.
 */
async function loadSolidTransform(projectRoot: string): Promise<SolidTransform> {
  const integration = resolvePackageDir("@astrojs/solid-js", projectRoot);
  const plugin = resolvePackageDir("vite-plugin-solid", integration);
  const babel: unknown = await import(resolveFrom("@babel/core", plugin));
  const presetModule: unknown = await import(resolveFrom("babel-preset-solid", plugin));
  const transformAsync = isRecord(babel) ? babel.transformAsync : undefined;
  const preset = isRecord(presetModule) ? presetModule.default : undefined;
  if (!isTransformAsync(transformAsync)) throw new Error(`@babel/core from ${plugin} has no transformAsync`);
  if (typeof preset !== "function") throw new Error(`babel-preset-solid from ${plugin} exports no preset`);

  return async (source, filename, options) => {
    // The options vite-plugin-solid's transform passes (dist/esm/index.mjs, `transform`).
    const result = await transformAsync(source, {
      root: projectRoot,
      filename,
      sourceFileName: filename,
      presets: [[preset, { generate: options.generate, hydratable: options.hydratable }]],
      plugins: [],
      ast: false,
      sourceMaps: true,
      configFile: false,
      babelrc: false,
      parserOpts: { plugins: options.typescript ? ["jsx", "typescript"] : ["jsx"] },
    });
    const code = isRecord(result) ? result.code : undefined;
    if (typeof code !== "string") throw new Error(`babel-preset-solid produced no code for ${filename}`);
    return code;
  };
}

function resolvePackageDir(name: string, fromDir: string): string {
  return path.dirname(resolveFrom(`${name}/package.json`, fromDir));
}

function resolveFrom(specifier: string, fromDir: string): string {
  try {
    return Bun.resolveSync(specifier, fromDir);
  } catch {
    throw new Error(`Cannot compile Solid JSX: ${specifier} is not resolvable from ${fromDir}`);
  }
}

function isTransformAsync(value: unknown): value is TransformAsync {
  return typeof value === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
