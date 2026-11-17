import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { parseAstroRenderer } from "../../packages/core/src/astro-host/renderers";
import type { FrameworkCompiler } from "../../packages/core/src/framework-compile/types";
import { __resetForTests, initAstroHost, type AstroHost } from "../../packages/pletivo/src/astro-host/runner";
import { resolveComponentPath } from "../../packages/pletivo/src/astro-plugin";
import { frameworkCompilePlugin } from "../../packages/pletivo/src/framework-compile";
import { configureAstroIslands, renderFrameworkComponent, renderValueToString } from "../../packages/runtime/src/astro-islands";
import { markNativeComponent } from "../../packages/runtime/src/astro-islands/native";
import { createHtml } from "../../packages/runtime/src/html-string";
import { Fragment as ShimFragment, renderComponent, runInPage, type AstroResult } from "../../packages/runtime/src/astro-shim";
import { Fragment as JsxFragment, jsx } from "../../packages/runtime/src/jsx-runtime";

describe("parseAstroRenderer", () => {
  test("reads a name and string entrypoints", () => {
    expect(
      parseAstroRenderer({ name: "@astrojs/react", serverEntrypoint: "@astrojs/react/server.js", clientEntrypoint: "@astrojs/react/client.js" }),
    ).toEqual({ name: "@astrojs/react", serverEntrypoint: "@astrojs/react/server.js", clientEntrypoint: "@astrojs/react/client.js" });
  });

  test("turns a file URL into a path and keeps a missing client entrypoint as null", () => {
    expect(parseAstroRenderer({ name: "x", serverEntrypoint: new URL("file:///srv/x/server.js") })).toEqual({
      name: "x",
      serverEntrypoint: "/srv/x/server.js",
      clientEntrypoint: null,
    });
  });

  test("names what is missing", () => {
    expect(parseAstroRenderer(null)).toEqual({ error: "not an object" });
    expect(parseAstroRenderer({ serverEntrypoint: "a" })).toEqual({ error: "no name" });
    expect(parseAstroRenderer({ name: "x" })).toEqual({ error: '"x" has no serverEntrypoint' });
  });
});

describe("addRenderer", () => {
  const root = path.join(import.meta.dir, "__astro-renderer-seams-fixture__");
  let host: AstroHost;

  beforeAll(async () => {
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(
      path.join(root, "astro.config.mjs"),
      `
const renderer = (name) => ({
  name,
  hooks: { "astro:config:setup": ({ addRenderer }) => addRenderer({ name, serverEntrypoint: name + "/server.js" }) },
});
export default { integrations: [renderer("@astrojs/preact"), renderer("@astrojs/vue"), { name: "bad", hooks: { "astro:config:setup": ({ addRenderer }) => addRenderer({}) } }] };
`,
    );
    __resetForTests();
    const initialized = await initAstroHost(root, "build");
    if (!initialized) throw new Error("no astro host");
    host = initialized;
    await host.ready;
  });

  afterAll(async () => {
    __resetForTests();
    await fs.rm(root, { recursive: true, force: true });
  });

  test("records valid renderers in registration order and skips invalid ones", () => {
    expect(host.renderers.map((r) => r.name)).toEqual(["@astrojs/preact", "@astrojs/vue"]);
  });
});

describe("resolveComponentPath", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "pletivo-component-path-"));
    await fs.writeFile(path.join(dir, "Real.tsx"), "");
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("makes a relative specifier absolute against the importer, without adding an extension", () => {
    expect(resolveComponentPath("./Counter", path.join(dir, "page.astro"))).toBe(path.join(dir, "Counter"));
  });

  test("falls back from a missing .jsx to an existing .tsx", () => {
    expect(resolveComponentPath("./Real.jsx", path.join(dir, "page.astro"))).toBe(path.join(dir, "Real.tsx"));
    expect(resolveComponentPath("./Gone.jsx", path.join(dir, "page.astro"))).toBe(path.join(dir, "Gone.jsx"));
  });

  test("keeps the compiler's script ids, even for a file outside the cwd", () => {
    const id = "../../packages/ui/src/Card.astro?astro&type=script&index=0&lang.ts";
    expect(resolveComponentPath(id, "/repo/packages/ui/src/Card.astro")).toBe(id);
  });

  test("keeps a bare specifier", () => {
    expect(resolveComponentPath("some-package/Comp", path.join(dir, "page.astro"))).toBe("some-package/Comp");
  });
});

describe("frameworkCompilePlugin", () => {
  test("compiles an offered extension, passes on a null result, and reports CSS", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pletivo-framework-compile-"));
    try {
      await fs.writeFile(path.join(dir, "Widget.fake"), "WIDGET");
      await fs.writeFile(path.join(dir, "entry.ts"), 'import value from "./Widget.fake"; export default value;');
      const declining: FrameworkCompiler = { framework: "None", extensions: [".fake"], compile: async () => null };
      const compiling: FrameworkCompiler = {
        framework: "Fake",
        extensions: [".fake"],
        compile: async ({ source, target }) => ({
          code: `export default ${JSON.stringify(`${source}:${target}`)};`,
          loader: "js",
          css: ".widget{}",
        }),
      };
      const css: string[] = [];
      const result = await Bun.build({
        entrypoints: [path.join(dir, "entry.ts")],
        plugins: [
          frameworkCompilePlugin({
            compilers: [declining, compiling],
            target: "client",
            onCss: (filename, text) => css.push(`${path.basename(filename)} ${text}`),
          }),
        ],
      });
      expect(result.success).toBe(true);
      expect(await result.outputs[0]!.text()).toContain('"WIDGET:client"');
      expect(css).toEqual(["Widget.fake .widget{}"]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("frameworkCompilePlugin as a runtime plugin", () => {
  test("compiles an import with dev's cache-bust query", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pletivo-framework-runtime-"));
    try {
      await fs.writeFile(path.join(dir, "Widget.w0seam"), "WIDGET");
      Bun.plugin(
        frameworkCompilePlugin({
          compilers: [
            {
              framework: "Fake",
              extensions: [".w0seam"],
              compile: async ({ source, filename, target }) => ({
                code: `export default ${JSON.stringify(`${source}:${target}:${path.basename(filename)}`)};`,
                loader: "js",
                css: null,
              }),
            },
          ],
          target: "server",
          onCss: () => {},
        }),
      );
      const mod = await import(path.join(dir, "Widget.w0seam") + "?v=3");
      expect(mod.default).toBe("WIDGET:server:Widget.w0seam");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("frameworkCompilePlugin when every compiler declines", () => {
  test("returns a script file as written and fails by name for any other file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pletivo-framework-decline-"));
    try {
      await fs.writeFile(path.join(dir, "plain.ts"), "export default 'plain' as string;");
      await fs.writeFile(path.join(dir, "Odd.w0odd"), "x");
      await fs.writeFile(path.join(dir, "a.ts"), 'import v from "./plain.ts"; export default v;');
      await fs.writeFile(path.join(dir, "b.ts"), 'import v from "./Odd.w0odd"; export default v;');
      const declining: FrameworkCompiler = { framework: "None", extensions: [".ts", ".w0odd"], compile: async () => null };
      const plugin = () => frameworkCompilePlugin({ compilers: [declining], target: "client", onCss: () => {} });
      const ok = await Bun.build({ entrypoints: [path.join(dir, "a.ts")], plugins: [plugin()] });
      expect(ok.success).toBe(true);
      expect(await ok.outputs[0]!.text()).toContain('"plain"');
      const failed = await Bun.build({ entrypoints: [path.join(dir, "b.ts")], plugins: [plugin()], throw: false });
      expect(failed.success).toBe(false);
      expect(failed.logs.map((log) => log.message).join("\n")).toContain("Odd.w0odd: no framework compiler accepted this file");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the island hook in its callers", () => {
  const notImplemented = /renderFrameworkComponent is not implemented yet/;
  const Widget = () => createHtml("<i>w</i>");
  const NativeContent = markNativeComponent(() => createHtml("<p>content</p>"));

  test("offers framework components once configured, and never pletivo's own", async () => {
    configureAstroIslands({
      renderers: [{ name: "fake", clientEntrypoint: null, ssr: { check: () => true, renderToStaticMarkup: () => ({ html: "" }) } }],
      urls: { component: () => "", renderer: () => "", beforeHydration: null },
      scripts: { island: "", directives: {} },
    });
    try {
      const result: AstroResult = {
        createAstro: () => {
          throw new Error("not used");
        },
        pageContext: {},
      };
      const page = { url: new URL("https://example.com/") };
      await expect(renderComponent(result, "Widget", Widget, {}, {})).rejects.toThrow(notImplemented);
      expect(String(await renderComponent(result, "Fragment", ShimFragment, {}, { default: () => "f" }))).toBe("f");
      expect(String(await renderComponent(result, "Content", NativeContent, {}, {}))).toBe("<p>content</p>");
      expect(String(await renderComponent(result, "Widget", Widget, { client: "load" }, {}))).toBe("<i>w</i>");
      await runInPage(page, async () => {
        expect(() => jsx(Widget, {})).toThrow(notImplemented);
        expect(String(await jsx(JsxFragment, { children: "j" }))).toBe("j");
        expect(String(await jsx(NativeContent, {}))).toBe("<p>content</p>");
        expect(String(await jsx(Widget, { client: "load" }))).toContain("<pletivo-island");
      });
      // Outside a page there is no result to key renderers on.
      expect(String(await jsx(Widget, {}))).toBe("<i>w</i>");
    } finally {
      configureAstroIslands(null);
    }
  });
});

describe("renderFrameworkComponent", () => {
  test("stays out of the way until a host configures renderers", () => {
    expect(
      renderFrameworkComponent({ source: "astro", result: {}, displayName: "X", Component: () => "", props: {}, slots: {} }),
    ).toBeNull();
  });

  test("renders slot values through the shim", async () => {
    expect(await renderValueToString(["a", createHtml("<b>b</b>"), "<c>"])).toBe("a<b>b</b>&lt;c&gt;");
  });
});
