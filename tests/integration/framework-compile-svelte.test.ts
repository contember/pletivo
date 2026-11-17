import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "fs/promises";
import path from "path";
import { createRawSnippet, type Component } from "svelte";
import { render } from "svelte/server";
import type { FrameworkCompileOutput, FrameworkCompiler } from "../../packages/core/src/framework-compile/types";
import { parseSvelteConfig } from "../../packages/core/src/framework-compile/svelte";
import { loadSvelteCompiler } from "../../packages/pletivo/src/framework-compile/svelte";

/** Astro's framework-svelte example: its Counter.svelte and its `vitePreprocess()` svelte.config.js, plus Imports.svelte. */
const FIXTURE = path.join(import.meta.dir, "../fixture-framework-svelte");
const COUNTER = path.join(FIXTURE, "src/components/Counter.svelte");
/** A svelte.config.mjs with a preprocessor that throws on a marker and `compilerOptions` production must override. */
const CONFIG_FIXTURE = path.join(import.meta.dir, "../fixture-framework-svelte-config");
/** A svelte.config.js whose body throws. */
const BROKEN_CONFIG_FIXTURE = path.join(import.meta.dir, "../fixture-framework-svelte-broken-config");

// Astro 5.16.11's build of the example: the island's inner HTML (before `<!--astro:end-->`) and the page `<style>`.
const ASTRO_ISLAND_INNER_HTML =
  '<!--[--><div class="counter svelte-ziooqw"><button>-</button> <pre>0</pre> <button>+</button></div> <div class="message svelte-ziooqw"><astro-slot> <h1 data-astro-cid-j7pv25f6>Hello, Svelte!</h1> </astro-slot><!----></div><!--]-->';
const ASTRO_PAGE_CSS =
  ".counter.svelte-ziooqw{display:grid;font-size:2em;grid-template-columns:repeat(3,minmax(0,1fr));margin-top:2em;place-items:center}.message.svelte-ziooqw{text-align:center}";

function isComponent(value: unknown): value is Component<Record<string, unknown>> {
  return typeof value === "function";
}

/** Drops the whitespace and last semicolons a minifier drops, and nothing else, so rule and declaration order still count. */
function collapseCss(css: string): string {
  return css
    .replace(/\s+/g, " ")
    .replace(/\s*([{};:,])\s*/g, "$1")
    .replace(/;}/g, "}")
    .trim();
}

function importsOf(code: string): string[] {
  return new Bun.Transpiler({ loader: "js" }).scanImports(code).map((entry) => entry.path);
}

describe("Svelte compiler", () => {
  let compiler: FrameworkCompiler;
  let outDir: string;
  let source: string;

  beforeAll(async () => {
    compiler = await loadSvelteCompiler(FIXTURE);
    source = await Bun.file(COUNTER).text();
    // Inside the fixture so the compiled module resolves `svelte` from the repo.
    outDir = await fs.mkdtemp(path.join(FIXTURE, ".compiled-"));
  });

  afterAll(async () => {
    await fs.rm(outDir, { recursive: true, force: true });
  });

  async function compile(target: "server" | "client"): Promise<FrameworkCompileOutput> {
    const output = await compiler.compile({ source, filename: COUNTER, target });
    if (!output) throw new Error("the Svelte compiler declined a .svelte file");
    return output;
  }

  test("server output renders the island body Astro renders", async () => {
    const output = await compile("server");
    expect(output.loader).toBe("js");
    const modulePath = path.join(outDir, "Counter.server.js");
    await Bun.write(modulePath, output.code);
    const mod: unknown = await import(modulePath);
    const Component = typeof mod === "object" && mod !== null && "default" in mod ? mod.default : null;
    if (!isComponent(Component)) throw new Error("the compiled module has no default component");

    // What @astrojs/svelte's renderToStaticMarkup passes for a hydrated island with a default slot.
    const slot = " <h1 data-astro-cid-j7pv25f6>Hello, Svelte!</h1> ";
    const children = createRawSnippet(() => ({ render: () => `<astro-slot>${slot}</astro-slot>` }));
    const result = await render(Component, {
      props: { "data-astro-cid-j7pv25f6": true, children, $$slots: { default: true } },
      idPrefix: "s0",
    });
    expect(result.body).toBe(ASTRO_ISLAND_INNER_HTML);
  });

  test("component CSS is returned, not imported, and matches Astro's page style", async () => {
    const output = await compile("server");
    if (output.css === null) throw new Error("no component CSS");
    expect(collapseCss(output.css)).toBe(ASTRO_PAGE_CSS);
    expect(importsOf(output.code).filter((specifier) => specifier.includes(".css"))).toEqual([]);
  });

  test("client output imports the client runtime and carries the same CSS", async () => {
    const [client, server] = [await compile("client"), await compile("server")];
    expect(client.loader).toBe("js");
    expect(importsOf(client.code)).toContain("svelte/internal/client");
    expect(importsOf(client.code)).not.toContain("svelte/internal/server");
    expect(importsOf(server.code)).toContain("svelte/internal/server");
    expect(client.css).toBe(server.css);
  });

  test("compiles for production, as Astro's build does", async () => {
    // `dev: true` tags the component with its filename (`$.FILENAME`) on both targets.
    for (const output of [await compile("client"), await compile("server")]) {
      expect(output.code).not.toContain("FILENAME");
    }
  });

  test("runs the svelte.config.js vitePreprocess(), which inlines a style @import", async () => {
    const filename = path.join(FIXTURE, "src/components/Imports.svelte");
    const output = await compiler.compile({ source: await Bun.file(filename).text(), filename, target: "server" });
    if (output?.css == null) throw new Error("no component CSS");
    expect(output.css).not.toContain("@import");
    expect(collapseCss(output.css)).toMatch(/^\.imported\.svelte-[a-z0-9]+\{color:red\}$/);
  });

  test("whitespace-only component CSS comes back as null", async () => {
    const filename = path.join(FIXTURE, "src/components/Blank.svelte");
    const output = await compiler.compile({ source: "<p>x</p><style>\n\n</style>", filename, target: "client" });
    expect(output?.css).toBeNull();
  });

  test("a compile error names the file", async () => {
    const filename = path.join(FIXTURE, "src/components/Broken.svelte");
    const compiling = compiler.compile({ source: "<div>{#if}</div>", filename, target: "server" });
    await expect(compiling).rejects.toThrow(`Error while compiling ${filename}`);
  });
});

describe("Svelte compiler with a svelte.config.mjs", () => {
  let compiler: FrameworkCompiler;

  beforeAll(async () => {
    compiler = await loadSvelteCompiler(CONFIG_FIXTURE);
  });

  async function compileStyled(target: "server" | "client"): Promise<FrameworkCompileOutput> {
    const output = await compiler.compile({
      source: '<p class="x">hi</p><style>.x{color:red}</style>',
      filename: path.join(CONFIG_FIXTURE, "src/Styled.svelte"),
      target,
    });
    if (!output) throw new Error("the Svelte compiler declined a .svelte file");
    return output;
  }

  test("applies compilerOptions, drops format and keeps the target's generate", async () => {
    const output = await compileStyled("server");
    expect(output.code).toContain("custom-hash");
    expect(output.css).toContain(".x.custom-hash");
    expect(importsOf(output.code)).toContain("svelte/internal/server");
  });

  test("forces dev and hmr off over the config's dev: true and hmr: true", async () => {
    for (const output of [await compileStyled("client"), await compileStyled("server")]) {
      expect(output.code).not.toContain("FILENAME");
      expect(output.code).not.toContain("import.meta.hot");
    }
  });

  test("a preprocess error names the file", async () => {
    const filename = path.join(CONFIG_FIXTURE, "src/Marked.svelte");
    const compiling = compiler.compile({ source: "<!-- fail --><p>hi</p>", filename, target: "server" });
    await expect(compiling).rejects.toThrow(`Error while preprocessing ${filename} - preprocessor refused the marker`);
  });
});

describe("svelte.config loading", () => {
  test("an error in the config body names the config file", async () => {
    const file = path.join(BROKEN_CONFIG_FIXTURE, "svelte.config.js");
    await expect(loadSvelteCompiler(BROKEN_CONFIG_FIXTURE)).rejects.toThrow(`Failed to load ${file} - config body exploded`);
  });

  test("preprocess: null means no preprocessors", () => {
    expect(parseSvelteConfig({ preprocess: null }, "svelte.config.js")).toEqual({ preprocess: null, compilerOptions: {} });
  });
});
