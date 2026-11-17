/**
 * The JSX compiler for Preact, React and Solid: which framework a project `.jsx`/`.tsx`
 * belongs to, and output each framework's own server renderer renders.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import path from "path";
import { jsx } from "@pletivo/runtime/jsx-runtime";
import type { ComponentFn } from "@pletivo/runtime/jsx-runtime";
import type { FrameworkCompileOutput, FrameworkCompileTarget, FrameworkCompiler } from "@pletivo/core/framework-compile/types";
import { loadJsxCompiler } from "../../packages/pletivo/src/framework-compile/jsx";
import { configureProjectCompilers, registerProjectSourcePlugin } from "../../packages/pletivo/src/project-source-plugin";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const FIXTURE = path.join(import.meta.dir, "../fixture-framework-jsx");
const TSCONFIG_FIXTURE = path.join(import.meta.dir, "../fixture-framework-jsx-tsconfig");
const SOURCE_FIXTURE = path.join(import.meta.dir, "../fixture-framework-jsx-source");
const OUT_DIR = path.join(FIXTURE, "dist");

const PREACT = "@astrojs/preact";
const REACT = "@astrojs/react";
const SOLID = "@astrojs/solid-js";

type Fn = (...args: unknown[]) => unknown;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFn(value: unknown): value is Fn {
  return typeof value === "function";
}

function isComponentFn(value: unknown): value is ComponentFn {
  return typeof value === "function";
}

function exportOf(mod: unknown, name: string): Fn {
  const value = isRecord(mod) ? mod[name] : undefined;
  if (!isFn(value)) throw new Error(`module has no function export ${name}`);
  return value;
}

/** Imports `specifier` as the integration's server entrypoint would find it. */
async function importFrom(specifier: string, fromDir: string): Promise<unknown> {
  return import(Bun.resolveSync(specifier, fromDir));
}

function packageDir(name: string, fromDir: string): string {
  return path.dirname(Bun.resolveSync(`${name}/package.json`, fromDir));
}

const EXTENSION_FOR_LOADER: Record<FrameworkCompileOutput["loader"], string> = {
  js: ".js",
  jsx: ".jsx",
  ts: ".ts",
  tsx: ".tsx",
};

let outputs = 0;

/** Writes `output` next to the fixture, so its imports resolve from there, and imports its default export. */
async function importOutput(output: FrameworkCompileOutput): Promise<unknown> {
  mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `output-${++outputs}${EXTENSION_FOR_LOADER[output.loader]}`);
  writeFileSync(file, output.code);
  const mod: unknown = await import(file);
  return isRecord(mod) ? mod.default : undefined;
}

async function compileFile(
  compiler: FrameworkCompiler,
  filename: string,
  target: FrameworkCompileTarget = "server",
): Promise<FrameworkCompileOutput | null> {
  return compiler.compile({ source: await Bun.file(filename).text(), filename, target });
}

async function compileRequired(
  compiler: FrameworkCompiler,
  filename: string,
  target: FrameworkCompileTarget = "server",
): Promise<FrameworkCompileOutput> {
  const output = await compileFile(compiler, filename, target);
  if (output === null) throw new Error(`${filename} was not compiled`);
  return output;
}

async function renderPreact(component: unknown, props: Record<string, unknown>): Promise<unknown> {
  const preact = await importFrom("preact", REPO_ROOT);
  const renderer = await importFrom("preact-render-to-string", packageDir(PREACT, REPO_ROOT));
  return exportOf(renderer, "render")(exportOf(preact, "h")(component, props));
}

afterAll(() => {
  configureProjectCompilers([]);
  rmSync(OUT_DIR, { recursive: true, force: true });
});

describe("JSX compiled for each framework's server renderer", () => {
  test("Preact: the pragma is prepended on line 1 and preact-render-to-string renders it", async () => {
    const compiler = await loadJsxCompiler(REPO_ROOT, [PREACT, REACT, SOLID]);
    const file = path.join(FIXTURE, "pragma/PreactCounter.tsx");
    const output = await compileRequired(compiler, file);

    const source = await Bun.file(file).text();
    expect(output).toEqual({ code: `/** @jsxImportSource preact */ ${source}`, loader: "tsx", css: null });
    expect(output.code.split("\n").length).toBe(source.split("\n").length);
    expect(await renderPreact(await importOutput(output), { count: 3 })).toBe('<div class="counter"><pre>3</pre></div>');
  });

  test("React: the pragma is prepended and react-dom/server renders it", async () => {
    const compiler = await loadJsxCompiler(REPO_ROOT, [PREACT, REACT, SOLID]);
    const file = path.join(FIXTURE, "pragma/ReactCounter.jsx");
    const output = await compileRequired(compiler, file);

    expect(output.code.startsWith("/** @jsxImportSource react */ /** @jsxImportSource react */")).toBe(true);
    expect(output.loader).toBe("jsx");
    expect(output.css).toBeNull();
    const react = await importFrom("react", REPO_ROOT);
    const server = await importFrom("react-dom/server", REPO_ROOT);
    const element = exportOf(react, "createElement")(await importOutput(output), { count: 3 });
    expect(exportOf(server, "renderToStaticMarkup")(element)).toBe('<div class="counter"><pre>3</pre></div>');
  });

  test("Solid: babel-preset-solid generates hydratable SSR that solid-js/web renders", async () => {
    const compiler = await loadJsxCompiler(REPO_ROOT, [PREACT, REACT, SOLID]);
    const output = await compileRequired(compiler, path.join(FIXTURE, "pragma/SolidCounter.tsx"));

    // TypeScript is kept for Bun to strip, as vite-plugin-solid leaves it for esbuild.
    expect(output.loader).toBe("ts");
    expect(output.css).toBeNull();
    expect(output.code).toContain("type JSX");
    expect(output.code).toContain("ssrHydrationKey");

    const component = await importOutput(output);
    const web = await importFrom("solid-js/web", REPO_ROOT);
    const html = exportOf(web, "renderToString")(
      () => exportOf(web, "createComponent")(component, { children: "Hello, Solid!" }),
      { renderId: "s0" },
    );
    // Astro's renderer nests the component deeper, hence its longer `s00000` keys.
    expect(html).toBe(
      '<div data-hk="s000" class="counter"><button>-</button><pre>0</pre><button>+</button></div>' +
        '<div data-hk="s001" class="counter-message">Hello, Solid!</div>',
    );
  });
});

test("a Solid compile leaves Error's stack-trace hooks as they were", async () => {
  const { prepareStackTrace, stackTraceLimit } = Error;
  const compiler = await loadJsxCompiler(REPO_ROOT, [SOLID]);
  await compileRequired(compiler, path.join(FIXTURE, "pragma/SolidCounter.tsx"));
  expect(Error.prepareStackTrace).toBe(prepareStackTrace);
  expect(Error.stackTraceLimit).toBe(stackTraceLimit);
  // What Vite's bundled follow-redirects does at import time, and threw under Babel's hook.
  expect(() => Error.captureStackTrace({})).not.toThrow();
});

describe("JSX compiled for the browser", () => {
  test("Solid generates DOM code", async () => {
    const compiler = await loadJsxCompiler(REPO_ROOT, [SOLID]);
    const output = await compileRequired(compiler, path.join(FIXTURE, "pragma/SolidCounter.tsx"), "client");
    expect(output.loader).toBe("ts");
    expect(output.code).toContain("getNextElement");
    expect(output.code).not.toContain("ssrHydrationKey");
  });

  test("Preact and React carry the pragma", async () => {
    const compiler = await loadJsxCompiler(REPO_ROOT, [PREACT, REACT]);
    const preact = await compileRequired(compiler, path.join(FIXTURE, "pragma/PreactCounter.tsx"), "client");
    const react = await compileRequired(compiler, path.join(FIXTURE, "pragma/ReactCounter.jsx"), "client");
    expect(preact.code.startsWith("/** @jsxImportSource preact */ ")).toBe(true);
    expect(react.code.startsWith("/** @jsxImportSource react */ ")).toBe(true);
  });
});

describe("which framework a file belongs to", () => {
  test("each file's pragma, with several JSX renderers registered", async () => {
    const compiler = await loadJsxCompiler(REPO_ROOT, [PREACT, SOLID, REACT, "@astrojs/svelte", "@astrojs/vue"]);
    const preact = await compileRequired(compiler, path.join(FIXTURE, "pragma/PreactCounter.tsx"));
    const react = await compileRequired(compiler, path.join(FIXTURE, "pragma/ReactCounter.jsx"));
    const solid = await compileRequired(compiler, path.join(FIXTURE, "pragma/SolidCounter.tsx"));
    expect(preact.code.startsWith("/** @jsxImportSource preact */ ")).toBe(true);
    expect(react.code.startsWith("/** @jsxImportSource react */ ")).toBe(true);
    expect(solid.code).toContain("ssrHydrationKey");
  });

  test("the nearest tsconfig's jsxImportSource, through extends", async () => {
    const compiler = await loadJsxCompiler(REPO_ROOT, [PREACT, REACT]);
    const output = await compileRequired(compiler, path.join(TSCONFIG_FIXTURE, "Card.jsx"));
    expect(output.code.startsWith("/** @jsxImportSource react */ ")).toBe(true);
  });

  test("the file's pragma over its tsconfig's jsxImportSource", async () => {
    const compiler = await loadJsxCompiler(REPO_ROOT, [PREACT, REACT]);
    const output = await compileRequired(compiler, path.join(TSCONFIG_FIXTURE, "PreactCard.jsx"));
    expect(output.code.startsWith("/** @jsxImportSource preact */ /** @jsxImportSource preact */")).toBe(true);
  });

  test("the only JSX renderer, for a file with no pragma and no tsconfig jsxImportSource", async () => {
    const compiler = await loadJsxCompiler(REPO_ROOT, ["@astrojs/svelte", PREACT]);
    const output = await compileRequired(compiler, path.join(FIXTURE, "plain/Card.jsx"));
    expect(output.code.startsWith("/** @jsxImportSource preact */ ")).toBe(true);
    expect(await renderPreact(await importOutput(output), { name: "Ada" })).toBe('<p class="card">Hello Ada</p>');
  });

  test("none for a file with no signal when two JSX renderers are registered", async () => {
    const compiler = await loadJsxCompiler(REPO_ROOT, [PREACT, REACT]);
    expect(await compileFile(compiler, path.join(FIXTURE, "plain/Card.jsx"))).toBeNull();
  });

  test("none when the framework's renderer is not registered", async () => {
    const compiler = await loadJsxCompiler(REPO_ROOT, [PREACT]);
    expect(await compileFile(compiler, path.join(FIXTURE, "pragma/ReactCounter.jsx"))).toBeNull();
    expect(await compileFile(compiler, path.join(TSCONFIG_FIXTURE, "Card.jsx"))).toBeNull();
  });

  test("none for pletivo's own JSX and for a pragma past the first statement", async () => {
    const compiler = await loadJsxCompiler(REPO_ROOT, [PREACT]);
    expect(await compileFile(compiler, path.join(FIXTURE, "pletivo/Card.jsx"))).toBeNull();
    expect(await compileFile(compiler, path.join(FIXTURE, "late-pragma/Card.jsx"))).toBeNull();
  });
});

describe("project-source-plugin", () => {
  async function importSource(file: string): Promise<unknown> {
    const mod: unknown = await import(path.join(SOURCE_FIXTURE, "src", file));
    return isRecord(mod) ? mod.default : undefined;
  }

  async function renderPletivo(component: unknown): Promise<string> {
    if (!isComponentFn(component)) throw new Error("not a component");
    return (await jsx(component, { name: "Ada" })).__html;
  }

  test("compiles a project .tsx for Preact when the compiler is configured", async () => {
    await registerProjectSourcePlugin(SOURCE_FIXTURE, "src");
    configureProjectCompilers([await loadJsxCompiler(SOURCE_FIXTURE, [PREACT])]);
    expect(await renderPreact(await importSource("Card.tsx"), { name: "Ada" })).toBe('<p class="card">Hello Ada</p>');
    // The compiler declines pletivo's own JSX, which Bun then compiles as before.
    expect(await renderPletivo(await importSource("pletivo/Configured.tsx"))).toBe('<p class="card">Hello Ada</p>');
  });

  test("leaves JSX to Bun when no compiler is configured", async () => {
    await registerProjectSourcePlugin(SOURCE_FIXTURE, "src");
    const compiled: string[] = [];
    configureProjectCompilers([{
      framework: "Stub",
      extensions: [".jsx", ".tsx"],
      async compile(input) {
        compiled.push(path.basename(input.filename));
        return null;
      },
    }]);
    expect(await renderPletivo(await importSource("pletivo/Stubbed.tsx"))).toBe('<p class="card">Hello Ada</p>');
    expect(compiled).toEqual(["Stubbed.tsx"]);

    configureProjectCompilers([]);
    expect(await renderPletivo(await importSource("pletivo/Card.tsx"))).toBe('<p class="card">Hello Ada</p>');
    expect(compiled).toEqual(["Stubbed.tsx"]);
  });

  test("runs the compiler of a file's longest suffix", async () => {
    await registerProjectSourcePlugin(SOURCE_FIXTURE, "src");
    const stub = (framework: string, extensions: string[]): FrameworkCompiler => ({
      framework,
      extensions,
      compile: async ({ source }) => ({ code: `export default ${JSON.stringify(`${framework}: ${source.trim()}`)};`, loader: "js", css: null }),
    });
    // `.js` is offered to Generic too, so only the longest suffix keeps store.w0mod.js away from it.
    configureProjectCompilers([stub("Generic", [".js"]), stub("Module", [".w0mod.js"])]);
    try {
      expect(await importSource("modules/store.w0mod.js")).toBe('Module: export default "as written";');
      expect(await importSource("modules/plain.js")).toBe('Generic: export default "plain";');
    } finally {
      configureProjectCompilers([]);
    }
  });

  test("fails by name when a compiled project module leaves CSS for the host", async () => {
    await registerProjectSourcePlugin(SOURCE_FIXTURE, "src");
    configureProjectCompilers([
      { framework: "Styled", extensions: [".w0css.js"], compile: async () => ({ code: "export default 1;", loader: "js", css: ".x{}" }) },
    ]);
    try {
      const file = path.join(SOURCE_FIXTURE, "src/modules/styled.w0css.js");
      await expect(import(file)).rejects.toThrow(`${file}: a compiled project module's CSS must be imported by the module`);
    } finally {
      configureProjectCompilers([]);
    }
  });
});
