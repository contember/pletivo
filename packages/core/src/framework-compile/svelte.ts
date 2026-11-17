/**
 * `.svelte` compiled the way `@sveltejs/vite-plugin-svelte` compiles it in Astro's
 * production build: the `svelte.config.*` `preprocess` first, then `svelte/compiler`
 * with the plugin's options. The host loads the project's compiler and config.
 */
import type { FrameworkCompileInput, FrameworkCompileOutput, FrameworkCompiler } from "./types";

/** A `svelte.config.*` `preprocess` value: a preprocessor group or an array of them, passed to Svelte as is. */
export type SveltePreprocess = object;

export type SvelteCompileOptions = Readonly<Record<string, unknown>>;

export interface SvelteCompileResult {
  js: { code: string };
  css: { code: string } | null;
}

/** The part of the project's `svelte/compiler` this compiler calls. */
export interface SvelteCompilerModule {
  preprocess(source: string, preprocess: SveltePreprocess, options: { filename: string }): Promise<{ code: string }>;
  compile(source: string, options: SvelteCompileOptions): SvelteCompileResult;
}

/** The fields of a `svelte.config.*` default export the compile reads. */
export interface SvelteConfig {
  preprocess: SveltePreprocess | null;
  compilerOptions: SvelteCompileOptions;
}

export interface CreateSvelteCompilerOptions {
  compiler: SvelteCompilerModule;
  config: SvelteConfig;
  /** Svelte's `rootDir`; the default `cssHash` hashes the filename relative to it. */
  projectRoot: string;
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCompileResult(value: unknown): SvelteCompileResult {
  if (!isRecord(value) || !isRecord(value.js) || typeof value.js.code !== "string") {
    throw new Error("svelte/compiler compile() returned no js.code");
  }
  const css = value.css;
  if (css === null || css === undefined) return { js: { code: value.js.code }, css: null };
  if (!isRecord(css) || typeof css.code !== "string") throw new Error("svelte/compiler compile() returned css without code");
  return { js: { code: value.js.code }, css: { code: css.code } };
}

function parsePreprocessResult(value: unknown): { code: string } {
  if (!isRecord(value) || typeof value.code !== "string") throw new Error("svelte/compiler preprocess() returned no code");
  return { code: value.code };
}

/** The project's `svelte/compiler` module, checked once where the host imports it. */
export function parseSvelteCompilerModule(value: unknown): SvelteCompilerModule {
  if (!isRecord(value)) throw new Error("svelte/compiler is not a module");
  const { compile, preprocess } = value;
  if (typeof compile !== "function" || typeof preprocess !== "function") {
    throw new Error("svelte/compiler exports no compile() and preprocess()");
  }
  return {
    preprocess: async (source, groups, options) => parsePreprocessResult(await preprocess(source, groups, options)),
    compile: (source, options) => parseCompileResult(compile(source, options)),
  };
}

/** A `svelte.config.*` default export; `file` names it in errors. */
export function parseSvelteConfig(value: unknown, file: string): SvelteConfig {
  if (!isRecord(value)) throw new Error(`invalid export in ${file}: expected an object`);
  const { preprocess, compilerOptions } = value;
  if (preprocess !== undefined && preprocess !== null) {
    const groups = Array.isArray(preprocess) ? preprocess : [preprocess];
    if (!groups.every(isRecord)) throw new Error(`invalid preprocess in ${file}: expected a preprocessor group or an array of them`);
  }
  if (compilerOptions !== undefined && !isRecord(compilerOptions)) {
    throw new Error(`invalid compilerOptions in ${file}: expected an object`);
  }
  return {
    preprocess: typeof preprocess === "object" && preprocess !== null ? preprocess : null,
    compilerOptions: compilerOptions ?? {},
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createSvelteCompiler({ compiler, config, projectRoot }: CreateSvelteCompilerOptions): FrameworkCompiler {
  // Svelte 5 rejects `format`; the plugin drops it. Its `generate` and `filename` are set per compile below.
  const { format: _format, ...userOptions } = config.compilerOptions;
  // The plugin's production defaults, then the user's options, then what production forces.
  const baseOptions: SvelteCompileOptions = {
    css: "external",
    rootDir: projectRoot,
    ...userOptions,
    dev: false,
    hmr: false,
  };

  return {
    framework: "Svelte",
    extensions: [".svelte"],
    async compile({ source, filename, target }: FrameworkCompileInput): Promise<FrameworkCompileOutput> {
      let code = source;
      if (config.preprocess !== null) {
        try {
          code = (await compiler.preprocess(source, config.preprocess, { filename })).code;
        } catch (error) {
          throw new Error(`Error while preprocessing ${filename} - ${describeError(error)}`, { cause: error });
        }
      }
      let result: SvelteCompileResult;
      try {
        result = compiler.compile(code, { ...baseOptions, filename, generate: target });
      } catch (error) {
        // Svelte's own toString() carries the code, the position and a code frame.
        throw new Error(`Error while compiling ${filename} - ${String(error)}`, { cause: error });
      }
      const css = result.css !== null && result.css.code.trim() !== "" ? result.css.code : null;
      return { code: result.js.code, loader: "js", css };
    },
  };
}
