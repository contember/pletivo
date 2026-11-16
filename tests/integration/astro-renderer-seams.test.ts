import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { parseAstroRenderer } from "../../packages/core/src/astro-host/renderers";
import type { FrameworkCompiler } from "../../packages/core/src/framework-compile/types";
import { __resetForTests, initAstroHost, type AstroHost } from "../../packages/pletivo/src/astro-host/runner";
import { resolveComponentPath } from "../../packages/pletivo/src/astro-plugin";
import { frameworkCompilePlugin } from "../../packages/pletivo/src/framework-compile";
import { renderFrameworkComponent, renderValueToString } from "../../packages/runtime/src/astro-islands";
import { createHtml } from "../../packages/runtime/src/html-string";
import "../../packages/runtime/src/astro-shim";

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
