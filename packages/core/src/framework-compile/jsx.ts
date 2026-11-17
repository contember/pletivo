/**
 * JSX written for Preact, React or Solid, compiled the way their Astro integrations do.
 * Preact and React need only their JSX runtime, named by a pragma Bun honours; Solid's
 * JSX compiles to template calls through `babel-preset-solid`, which the host passes in.
 */
import { jsxImportSourcePragma } from "../framework-jsx";
import type { FrameworkCompileInput, FrameworkCompileOutput, FrameworkCompiler } from "./types";

export type JsxFramework = "preact" | "react" | "solid-js";

/** Keyed by `jsxImportSource`; the value is the renderer the framework's integration registers. */
const RENDERER_BY_FRAMEWORK: Record<JsxFramework, string> = {
  preact: "@astrojs/preact",
  react: "@astrojs/react",
  "solid-js": "@astrojs/solid-js",
};

const JSX_FRAMEWORKS: readonly JsxFramework[] = ["preact", "react", "solid-js"];

function jsxFramework(importSource: string): JsxFramework | null {
  return JSX_FRAMEWORKS.find((framework) => framework === importSource) ?? null;
}

/** The `babel-preset-solid` options vite-plugin-solid passes under `@astrojs/solid-js`. */
export interface SolidTransformOptions {
  generate: "ssr" | "dom";
  hydratable: true;
  /** Parse TypeScript syntax. Types are kept in the output, for the next loader to strip. */
  typescript: boolean;
}

/** Compiles Solid JSX to JavaScript (plus types under `typescript`) through the project's Babel. */
export type SolidTransform = (source: string, filename: string, options: SolidTransformOptions) => Promise<string>;

export interface JsxCompilerHost {
  /** The nearest tsconfig's `compilerOptions.jsxImportSource` for `filename`, following `extends`. */
  tsconfigJsxImportSource(filename: string): string | null;
  /** Required when `@astrojs/solid-js` is registered. */
  transformSolid: SolidTransform | null;
}

/**
 * `rendererNames` are the project's registered renderers. A file belongs to the framework its
 * `@jsxImportSource` pragma names, else its tsconfig's, else the only JSX renderer registered.
 */
export function createJsxCompiler(rendererNames: readonly string[], host: JsxCompilerHost): FrameworkCompiler {
  const registered = JSX_FRAMEWORKS.filter((framework) => rendererNames.includes(RENDERER_BY_FRAMEWORK[framework]));
  const transformSolid = host.transformSolid;
  // With several JSX renderers, Astro splits files by each integration's include/exclude, which pletivo cannot read.
  const fallback = registered.length === 1 ? registered[0] : null;

  function frameworkOf(input: FrameworkCompileInput): JsxFramework | null {
    const pragma = jsxImportSourcePragma(input.source);
    if (pragma.kind === "unknown") return null;
    const importSource =
      pragma.kind === "leading" ? pragma.importSource : host.tsconfigJsxImportSource(input.filename);
    const framework = importSource === null ? fallback : jsxFramework(importSource);
    return framework !== null && registered.includes(framework) ? framework : null;
  }

  return {
    framework: "JSX",
    extensions: [".jsx", ".tsx"],
    async compile(input: FrameworkCompileInput): Promise<FrameworkCompileOutput | null> {
      const framework = frameworkOf(input);
      if (framework === null) return null;
      const typescript = input.filename.toLowerCase().endsWith(".tsx");
      if (framework === "solid-js") {
        if (transformSolid === null) {
          throw new Error(`${input.filename}: @astrojs/solid-js is registered, but no Solid JSX transform was provided`);
        }
        const code = await transformSolid(input.source, input.filename, {
          generate: input.target === "server" ? "ssr" : "dom",
          hydratable: true,
          typescript,
        });
        // Babel keeps TypeScript types, as under vite-plugin-solid, where esbuild strips them next.
        return { code, loader: typescript ? "ts" : "js", css: null };
      }
      // On line 1 without a newline, so line numbers hold. A BOM after it parses as whitespace.
      return { code: `/** @jsxImportSource ${framework} */ ${input.source}`, loader: typescript ? "tsx" : "jsx", css: null };
    },
  };
}
