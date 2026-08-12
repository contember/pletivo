import { describe, expect, test } from "bun:test";
import { createAstroCompiler } from "../src/astro-compiler.ts";
import { compileProject, needsTranspiler } from "../src/compile-project.ts";
import { astroWasmModule } from "./astro-wasm.ts";

const compiler = createAstroCompiler(await astroWasmModule());

const PROJECT = new Map<string, string>([
  [
    "src/components/Layout.astro",
    `---
import Header from "./Header.astro";
---
<html><head><title>t</title></head><body><Header /><slot /></body></html>
<style>body { margin: 0; }</style>
`,
  ],
  ["src/components/Header.astro", `<header>h</header>\n<style is:global>.h { color: red; }</style>\n`],
  [
    "src/pages/index.astro",
    `---
import Layout from "../components/Layout.astro";
import "../styles/site.css";
import { NAME } from "../lib/name.js";
---
<Layout><p>{NAME}</p></Layout>
`,
  ],
  ["src/lib/name.js", `export const NAME = "pletivo";\n`],
  ["src/styles/site.css", `.site { color: blue; }\n`],
  ["src/pages/notes.md", "# notes\n"],
  ["README.md", "readme\n"],
]);

const project = await compileProject(PROJECT, compiler);

describe("compileProject", () => {
  test("names a module for every file the bundle can hold, and nothing else", () => {
    expect([...project.moduleNames.keys()].sort()).toEqual([
      "src/components/Header.astro",
      "src/components/Layout.astro",
      "src/lib/name.js",
      "src/pages/index.astro",
      "src/styles/site.css",
    ]);
  });

  test("flattens every module to the bundle root, so `./name` always resolves", () => {
    for (const name of project.moduleNames.values()) expect(name).not.toContain("/");
    expect(project.moduleNames.get("src/pages/index.astro")).toBe("src_pages_index.astro.js");
  });

  test("ships @pletivo/runtime alongside the project", () => {
    expect(project.modules["pletivo-runtime.js"]).toContain("renderAstroPage");
  });

  test("points compiled output at the runtime module", () => {
    expect(project.modules["src_pages_index.astro.js"]).toContain('"./pletivo-runtime.js"');
  });

  test("rewrites a component import to its bundle name", () => {
    expect(project.modules["src_pages_index.astro.js"]).toContain(
      '"./src_components_Layout.astro.js"',
    );
  });

  test("resolves a `.js` import and carries the module verbatim", () => {
    expect(project.modules["src_pages_index.astro.js"]).toContain('"./src_lib_name.js.js"');
    expect(project.modules["src_lib_name.js.js"]).toBe('export const NAME = "pletivo";\n');
  });

  test("resolves a side-effect CSS import to an empty module", () => {
    expect(project.modules["src_pages_index.astro.js"]).toContain('"./src_styles_site.css.js"');
    expect(project.modules["src_styles_site.css.js"]).toBe("export {};\n");
  });

  test("strips the compiler's virtual style imports, which nothing resolves", () => {
    for (const source of Object.values(project.modules)) {
      expect(source).not.toContain("?astro&type=style");
    }
  });

  test("records the import graph in execution order, without the CSS stub", () => {
    expect(project.imports.get("src/pages/index.astro")).toEqual([
      "src/components/Layout.astro",
      "src/lib/name.js",
    ]);
    expect(project.imports.get("src/components/Layout.astro")).toEqual([
      "src/components/Header.astro",
    ]);
  });

  test("classifies a scoped block and an is:global one apart", () => {
    // The compiler rewrites and minifies a scoped block; an is:global one comes
    // back exactly as written, which is why the two cannot be told apart by shape.
    expect(project.styles.get("src/components/Layout.astro")?.blocks).toEqual([
      { global: false, css: "body{margin:0}" },
    ]);
    expect(project.styles.get("src/components/Header.astro")?.blocks).toEqual([
      { global: true, css: ".h { color: red; }" },
    ]);
  });

  test("keeps the scope hash the page HTML will carry", () => {
    const scope = project.styles.get("src/components/Layout.astro")?.scope;
    expect(scope).toMatch(/^[a-z0-9]+$/);
    expect(project.modules["src_components_Layout.astro.js"]).toContain(`astro-${scope}`);
  });
});

describe("compileProject, blocks in source order", () => {
  test("keeps a scoped block before the is:global one written after it", async () => {
    const one = await compileProject(
      new Map([
        [
          "src/pages/index.astro",
          `<div class="m">m</div>\n<style>.m { --a: 1; }</style>\n<style is:global>.g { --b: 2; }</style>\n`,
        ],
      ]),
      compiler,
    );
    const scope = one.styles.get("src/pages/index.astro")?.scope;
    expect(one.styles.get("src/pages/index.astro")?.blocks).toEqual([
      { global: false, css: `.m:where(.astro-${scope}){--a: 1}` },
      { global: true, css: ".g { --b: 2; }" },
    ]);
  });
});

describe("compileProject, refusals", () => {
  test("throws with the file name when the compiler reports an error", () => {
    expect(
      compileProject(new Map([["src/pages/index.astro", "<slot name/>"]]), compiler),
    ).rejects.toThrow(/src\/pages\/index\.astro.*slot\[name\] must be a static string/s);
  });
});

describe("needsTranspiler", () => {
  test("names the extensions that would need one inside the isolate", () => {
    expect(["a.ts", "a.tsx", "a.jsx", "a.mts"].map(needsTranspiler)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(["a.astro", "a.js", "a.mjs", "a.md"].map(needsTranspiler)).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });
});
