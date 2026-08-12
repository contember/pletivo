import { describe, expect, test } from "bun:test";
import { createAstroCompiler } from "../src/astro-compiler.ts";
import { compileProject, isExecutableModule } from "../src/compile-project.ts";
import { typescriptSuspects } from "../src/render.ts";
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

describe("compileProject, TypeScript in frontmatter", () => {
  const TYPED = new Map<string, string>([
    [
      "src/pages/index.astro",
      `---
import Card from "../components/Card.astro";
import type { Extra } from "../lib/types.ts";
export interface Props {
  title: string;
}
type Heading = 1 | 2;
const level: Heading = 2;
const { title }: Props = Astro.props;
---
<Card><h2>{title}{level}</h2></Card>
`,
    ],
    [
      "src/components/Card.astro",
      `---
export interface Props {}
---
<div class="card"><slot /></div>
<style>.card { color: navy; }</style>
`,
    ],
  ]);

  /**
   * Bun's `js` loader rejects TypeScript, so this is the same question the Worker
   * Loader asks — does the module parse as JavaScript — asked without an isolate.
   */
  const asJavaScript = new Bun.Transpiler({ loader: "js" });

  test("every generated module parses as JavaScript", async () => {
    const typed = await compileProject(TYPED, compiler);
    for (const [name, source] of Object.entries(typed.modules)) {
      expect(() => asJavaScript.transformSync(source), name).not.toThrow();
    }
  });

  test("leaves no TypeScript for the isolate's diagnostic to find", async () => {
    const typed = await compileProject(TYPED, compiler);
    expect(typescriptSuspects(typed.modules)).toEqual([]);
  });

  test("keeps the import graph the cascade order walks", async () => {
    const typed = await compileProject(TYPED, compiler);
    // The component import survives; the `import type` does not, and never was an edge.
    expect(typed.imports.get("src/pages/index.astro")).toEqual(["src/components/Card.astro"]);
    expect(typed.modules["src_pages_index.astro.js"]).toContain(
      '"./src_components_Card.astro.js"',
    );
    expect(typed.modules["src_pages_index.astro.js"]).not.toContain("../lib/types.ts");
  });

  test("renders the same page body as the same file without the annotations", async () => {
    // Stripping types must change nothing but the types: the compiled module for the
    // annotated page is the untyped one's, modulo the blanked-out lines.
    const untyped = new Map(TYPED);
    untyped.set(
      "src/pages/index.astro",
      `---
import Card from "../components/Card.astro";
const level = 2;
const { title } = Astro.props;
---
<Card><h2>{title}{level}</h2></Card>
`,
    );
    const a = await compileProject(TYPED, compiler);
    const b = await compileProject(untyped, compiler);
    const blank = (code: string): string =>
      code
        .split("\n")
        .filter((line) => line.trim() !== "")
        .join("\n");
    expect(blank(a.modules["src_pages_index.astro.js"])).toBe(
      blank(b.modules["src_pages_index.astro.js"]),
    );
  });

  test("names the file when the frontmatter does not parse at all", () => {
    expect(
      compileProject(new Map([["src/pages/index.astro", "---\nconst = ;\n---\n<p>x</p>\n"]]), compiler),
    ).rejects.toThrow(/src\/pages\/index\.astro.*position is in the compiled output/s);
  });
});

describe("compileProject, refusals", () => {
  test("throws with the file name when the compiler reports an error", () => {
    expect(
      compileProject(new Map([["src/pages/index.astro", "<slot name/>"]]), compiler),
    ).rejects.toThrow(/src\/pages\/index\.astro.*slot\[name\] must be a static string/s);
  });
});

describe("isExecutableModule", () => {
  test("names the extensions the isolate can be handed code for", () => {
    expect(["a.astro", "a.tsx", "a.ts", "a.jsx", "a.mts", "a.js", "a.mjs"].map(isExecutableModule))
      .toEqual([true, true, true, true, true, true, true]);
    // `.css` becomes a resolvable stub, not code; `.md` never becomes a module.
    expect(["a.css", "a.md", "a.mdx", "a.png"].map(isExecutableModule)).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });
});

describe("compileProject, specifiers that name no file map key on their own", () => {
  const files = new Map<string, string>([
    ["src/pages/index.astro", `---
import Layout from "../layouts/Layout";
import { NAME } from "../lib/name.js";
import { helper } from "../lib/util";
---
<Layout>{NAME}{helper()}</Layout>
`],
    ["src/layouts/Layout.astro", `<html><head><title>t</title></head><body><slot /></body></html>\n`],
    ["src/lib/name.ts", `export const NAME: string = "pletivo";\n`],
    ["src/lib/util/index.ts", `export const helper = (): string => "h";\n`],
  ]);

  test("resolves an extensionless import and a directory index, the way Bun does", async () => {
    const built = await compileProject(files, compiler);
    const page = built.modules["src_pages_index.astro.js"];
    expect(page).toContain(`"./${built.moduleNames.get("src/layouts/Layout.astro")}"`);
    expect(page).toContain(`"./${built.moduleNames.get("src/lib/util/index.ts")}"`);
  });

  test("resolves `./x.js` to the `x.ts` it lands on — TypeScript's own convention", async () => {
    const built = await compileProject(files, compiler);
    expect(built.modules["src_pages_index.astro.js"]).toContain(
      `"./${built.moduleNames.get("src/lib/name.ts")}"`,
    );
  });

  test("keeps the import graph and the rewritten specifiers on the same edges", async () => {
    const built = await compileProject(files, compiler);
    // The CSS cascade is ordered by this list, so a specifier the bundle resolves and
    // the graph does not would move a component's styles.
    expect(built.imports.get("src/pages/index.astro")).toEqual([
      "src/layouts/Layout.astro",
      "src/lib/name.ts",
      "src/lib/util/index.ts",
    ]);
  });

  test("still leaves a specifier nothing answers alone, so the Loader names it", async () => {
    const built = await compileProject(
      new Map([["src/pages/a.astro", `---\nimport "./missing";\n---\n<p>a</p>\n`]]),
      compiler,
    );
    expect(built.modules["src_pages_a.astro.js"]).toContain(`"./missing"`);
  });
});
