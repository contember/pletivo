/**
 * `.vue` components compile as @vitejs/plugin-vue does in `astro build`, so they render
 * the same HTML through Vue's server renderer and carry the same scope id and CSS.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BunPlugin } from "bun";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import * as compilerSfc from "vue/compiler-sfc";
import { createVueCompiler } from "@pletivo/core/framework-compile/vue";
import type { FrameworkCompileTarget, FrameworkCompiler } from "@pletivo/core/framework-compile/types";
import { frameworkCompilePlugin } from "../../packages/pletivo/src/framework-compile";
import { loadVueCompiler } from "../../packages/pletivo/src/framework-compile/vue";

const FIXTURE = path.join(import.meta.dir, "../fixture-framework-vue");
const COMPONENTS = path.join(FIXTURE, "src/components");
const TARGETS: readonly FrameworkCompileTarget[] = ["server", "client"];

/** What a compiled component exposes to these checks. */
interface HarnessComponent {
  ssrRender?: unknown;
  __ssrInlineRender?: unknown;
  render?: unknown;
  setup?: (props: object, context: { expose(): void }) => object;
}

/** The bundled `render.mjs`. */
interface HarnessModule {
  components: Record<string, HarnessComponent>;
  render(component: HarnessComponent | undefined, props: object, slots: Record<string, string>): Promise<string>;
}

interface Harness {
  module: HarnessModule;
  /** Component CSS by `.vue` file. */
  css: Map<string, string>;
}

let outDir: string;
let compiler: FrameworkCompiler;
const pletivo = new Map<FrameworkCompileTarget, Harness>();
const reference = new Map<FrameworkCompileTarget, Harness>();

beforeAll(async () => {
  outDir = mkdtempSync(path.join(os.tmpdir(), "pletivo-vue-compile-"));
  compiler = await loadVueCompiler(FIXTURE);
  for (const target of TARGETS) {
    const css = new Map<string, string>();
    const plugin = frameworkCompilePlugin({ compilers: [compiler], target, onCss: (file, text) => css.set(file, text) });
    pletivo.set(target, { module: await bundleHarness(`pletivo-${target}`, plugin), css });
    const referenceCss = new Map<string, string>();
    const referencePlugin = await pluginVueAsAstroRunsIt(target, referenceCss);
    reference.set(target, { module: await bundleHarness(`plugin-vue-${target}`, referencePlugin), css: referenceCss });
  }
});

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
});

function harness(builds: Map<FrameworkCompileTarget, Harness>, target: FrameworkCompileTarget): Harness {
  const built = builds.get(target);
  if (!built) throw new Error(`no ${target} harness`);
  return built;
}

/** Bundles the fixture's render harness with `.vue` files compiled by `plugin`, and imports it. */
async function bundleHarness(name: string, plugin: BunPlugin): Promise<HarnessModule> {
  const result = await Bun.build({
    entrypoints: [path.join(FIXTURE, "render.mjs")],
    target: "bun",
    plugins: [plugin],
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      __VUE_OPTIONS_API__: "true",
      __VUE_PROD_DEVTOOLS__: "false",
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false",
    },
  });
  if (!result.success) throw new AggregateError(result.logs, `${name} harness build failed`);
  const entry = result.outputs.find((output) => output.kind === "entry-point");
  if (!entry) throw new Error(`${name} harness has no entry point`);
  const file = path.join(outDir, `${name}.mjs`);
  writeFileSync(file, await entry.text());
  return import(file);
}

/**
 * @vitejs/plugin-vue, resolved through @astrojs/vue, with @astrojs/vue's options, hosted
 * as a Bun plugin. `astro build` runs content sync on a dev server sharing the plugin
 * instance first, so `configureServer` precedes the build's `configResolved`.
 */
async function pluginVueAsAstroRunsIt(target: FrameworkCompileTarget, css: Map<string, string>): Promise<BunPlugin> {
  const astroVue = path.dirname(Bun.resolveSync("@astrojs/vue/package.json", FIXTURE));
  const { default: vue } = await import(Bun.resolveSync("@vitejs/plugin-vue", astroVue));
  // `comments: false` stands in for NODE_ENV=production, under which Astro loads Vue's compiler.
  const plugin = vue({ template: { transformAssetUrls: false, compilerOptions: { comments: false } }, compiler: compilerSfc });
  plugin.configureServer({ config: { server: {}, esbuild: {} }, watcher: { on() {} } });
  plugin.configResolved({
    root: FIXTURE,
    command: "build",
    build: { sourcemap: false },
    isProduction: true,
    define: {},
    logger: { warn() {} },
    css: {},
  });
  plugin.buildStart();
  const ssr = target === "server";
  const context = {
    error(error: unknown) {
      throw error;
    },
    warn() {},
    addWatchFile() {},
  };
  const styles = new Map<string, string[]>();
  return {
    name: "plugin-vue-reference",
    setup(build) {
      build.onResolve({ filter: /\?vue&type=style/ }, (args) => ({ path: args.path, namespace: "plugin-vue-style" }));
      build.onLoad({ filter: /.*/, namespace: "plugin-vue-style" }, async (args) => {
        const block: { code: string } = plugin.load.call(context, args.path, { ssr });
        const style: { code: string } = await plugin.transform.call(context, block.code, args.path, { ssr });
        const file = args.path.slice(0, args.path.indexOf("?"));
        const blocks = styles.get(file) ?? [];
        blocks[Number(/[?&]index=(\d+)/.exec(args.path)?.[1])] = style.code;
        styles.set(file, blocks);
        css.set(file, blocks.join("\n"));
        return { contents: "", loader: "js" };
      });
      build.onResolve({ filter: /^\0plugin-vue:export-helper$/ }, () => ({
        path: "export-helper",
        namespace: "plugin-vue-helper",
      }));
      build.onLoad({ filter: /.*/, namespace: "plugin-vue-helper" }, () => ({
        contents: plugin.load.call(context, "\0plugin-vue:export-helper"),
        loader: "js",
      }));
      build.onLoad({ filter: /\.vue$/ }, async (args) => {
        const source = await Bun.file(args.path).text();
        const main: { code: string } = await plugin.transform.call(context, source, args.path, { ssr });
        return { contents: main.code, loader: "js" };
      });
    },
  };
}

/** @astrojs/vue's `check`: whether the component carries a server render function. */
function hasServerRender(component: HarnessComponent | undefined): boolean {
  return !!component?.ssrRender || !!component?.__ssrInlineRender;
}

// Astro's island inner HTML, from the built framework-vue and framework-multiple examples.
const ASTRO_COUNTER =
  '<!--[--><div class="counter"><button>-</button><pre>0</pre><button>+</button></div><div class="counter-message"><!--[--><astro-slot> <h1 data-astro-cid-j7pv25f6>Hello, Vue!</h1> </astro-slot><!--]--></div><!--]-->';
const ASTRO_VUE_COUNTER =
  '<!--[--><div class="counter"><button>-</button><pre>0</pre><button>+</button></div><div class="counter-message"><!--[--><astro-slot> <h1>Hello from Vue!</h1> </astro-slot><!--]--></div><!--]-->';

describe("server target", () => {
  test("<script setup lang=\"ts\"> renders Astro's HTML", async () => {
    const { module } = harness(pletivo, "server");
    expect(hasServerRender(module.components.Counter)).toBe(true);
    const html = await module.render(module.components.Counter, {}, { default: " <h1 data-astro-cid-j7pv25f6>Hello, Vue!</h1> " });
    expect(html).toBe(ASTRO_COUNTER);
  });

  test("<script lang=\"ts\"> renders Astro's HTML", async () => {
    const { module } = harness(pletivo, "server");
    expect(hasServerRender(module.components.VueCounter)).toBe(true);
    const html = await module.render(module.components.VueCounter, {}, { default: " <h1>Hello from Vue!</h1> " });
    expect(html).toBe(ASTRO_VUE_COUNTER);
  });

  test("an unscoped <style> is returned as CSS, not imported", async () => {
    const filename = path.join(COMPONENTS, "Counter.vue");
    const output = await compiler.compile({ source: await Bun.file(filename).text(), filename, target: "server" });
    expect(output?.loader).toBe("ts");
    expect(output?.css).toContain(".counter-message {");
    expect(output?.css).not.toContain("data-v-");
    expect(output?.code).not.toMatch(/import\s+["'][^"']*\.css/);
  });
});

describe("scoped <style>", () => {
  test("the rendered data-v-* attribute and the CSS selectors share one id", async () => {
    const { module, css } = harness(pletivo, "server");
    const html = await module.render(module.components.ScopedLabel, { label: "Hi" }, { default: "<b>slot</b>" });
    const ids = new Set(html.match(/data-v-[0-9a-f]{8}/g));
    expect(ids.size).toBe(1);
    const [id] = [...ids];
    expect(html).toBe(`<p class="label" ${id}><span ${id}>Hi</span><!--[--><astro-slot><b>slot</b></astro-slot><!--]--></p>`);
    expect(css.get(path.join(COMPONENTS, "ScopedLabel.vue"))).toBe(
      `\n.label[${id}] {\n\tfont-weight: bold;\n}\n.label span[${id}] {\n\tcolor: rebeccapurple;\n}\n`,
    );
  });
});

/** A component of the fixture, its props and slots, and what its HTML must show. */
interface Case {
  component: string;
  props: Record<string, unknown>;
  slots: Record<string, string>;
  /** Guards against a comparison of two equally empty renders. */
  shows: Record<FrameworkCompileTarget, RegExp>;
}

const CASES: Case[] = [
  { component: "Counter", props: {}, slots: { default: "<h1>Hi</h1>" }, shows: both(/<pre>0<\/pre>/) },
  { component: "VueCounter", props: {}, slots: { default: "<h1>Hi</h1>" }, shows: both(/<pre>0<\/pre>/) },
  { component: "ScopedLabel", props: { label: "Hi" }, slots: {}, shows: both(/data-v-[0-9a-f]{8}/) },
  {
    component: "ThemedLabel",
    props: { color: "red" },
    slots: {},
    // On the client the CSS variables are set by `useCssVars` after mount, not rendered.
    shows: { server: /style="--[^"]*:red;?"/, client: /data-v-[0-9a-f]{8}>red<\/p>/ },
  },
  { component: "TypedExpression", props: { value: 1.25 }, slots: {}, shows: both(/<p>1\.3<\/p>/) },
  { component: "AssetImage", props: {}, slots: {}, shows: both(/<img src="\.\/pixel-[^"]+\.png"/) },
];

function both(pattern: RegExp): Record<FrameworkCompileTarget, RegExp> {
  return { server: pattern, client: pattern };
}

describe("same output as @vitejs/plugin-vue in `astro build`", () => {
  for (const target of TARGETS) {
    for (const { component, props, slots, shows } of CASES) {
      test(`${component}, ${target} target: HTML and CSS`, async () => {
        const ours = harness(pletivo, target);
        const theirs = harness(reference, target);
        const html = await ours.module.render(ours.module.components[component], props, slots);
        expect(html).toMatch(shows[target]);
        expect(html).toBe(await theirs.module.render(theirs.module.components[component], props, slots));
        const file = path.join(COMPONENTS, `${component}.vue`);
        expect(ours.css.get(file)).toBe(theirs.css.get(file));
      });
    }
  }
});

describe("client target", () => {
  test("components carry DOM render functions, not server ones", () => {
    const { module } = harness(pletivo, "client");
    expect(hasServerRender(module.components.Counter)).toBe(false);
    expect(hasServerRender(module.components.VueCounter)).toBe(false);
    expect(typeof module.components.Counter?.render).toBe("function");
    expect(typeof module.components.VueCounter?.render).toBe("function");
  });

  // As Astro ships it (framework-vue's built Counter chunk): `setup` calls `expose()` and the
  // template is a separate render reading `$setup`, so a parent's template ref sees no bindings.
  const sources: { name: string; builds: Map<FrameworkCompileTarget, Harness> }[] = [
    { name: "pletivo", builds: pletivo },
    { name: "plugin-vue", builds: reference },
  ];
  for (const { name, builds } of sources) {
    test(`<script setup> keeps its render separate and calls expose() (${name})`, () => {
      const counter = harness(builds, "client").module.components.Counter;
      let exposed = 0;
      const bindings = counter?.setup?.({}, { expose: () => exposed++ });
      if (!bindings) throw new Error("Counter has no setup()");
      expect(exposed).toBe(1);
      expect(Object.getOwnPropertyDescriptor(bindings, "__isScriptSetup")?.value).toBe(true);
      expect(Object.keys(bindings).sort()).toEqual(["add", "count", "subtract"]);
      expect(typeof counter?.render).toBe("function");
    });
  }

  test("the module imports no server renderer", async () => {
    const filename = path.join(COMPONENTS, "Counter.vue");
    const output = await compiler.compile({ source: await Bun.file(filename).text(), filename, target: "client" });
    expect(output?.code).not.toContain("vue/server-renderer");
    expect(output?.code).not.toContain("useSSRContext");
  });
});

describe("errors", () => {
  const direct = createVueCompiler(compilerSfc, { root: FIXTURE });

  test("a template syntax error names the file", async () => {
    const filename = path.join(COMPONENTS, "Broken.vue");
    await expect(direct.compile({ source: "<template><div></template>\n", filename, target: "server" })).rejects.toThrow(
      filename,
    );
  });

  test("a script error names the file", async () => {
    const filename = path.join(COMPONENTS, "BrokenScript.vue");
    const source = '<script setup lang="ts">\nconst = 1;\n</script>\n<template><p /></template>\n';
    await expect(direct.compile({ source, filename, target: "client" })).rejects.toThrow(filename);
  });

  test("an unsupported style language is refused by name", async () => {
    const filename = path.join(COMPONENTS, "Sass.vue");
    const source = '<template><p /></template>\n<style lang="scss">p { a { color: red } }</style>\n';
    await expect(direct.compile({ source, filename, target: "server" })).rejects.toThrow('<style lang="scss">');
  });
});
