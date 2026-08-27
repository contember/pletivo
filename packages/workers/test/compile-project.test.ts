import { describe, expect, test } from "bun:test";
import { createAstroCompiler } from "../src/astro-compiler.ts";
import type { ProjectAssetInfo, ProjectAssetsView } from "../src/asset-port.ts";
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

const ENTRIES = ["src/pages/index.astro"];
const project = await compileProject({ files: PROJECT, entries: ENTRIES, compiler });

function moduleCode(built: Awaited<ReturnType<typeof compileProject>>, file: string): string {
  const name = built.moduleNames.get(file);
  if (name === undefined) throw new Error(`missing module name for ${file}`);
  const code = built.modules[name];
  if (code === undefined) throw new Error(`missing module body for ${file}`);
  return code;
}

describe("compileProject", () => {
  test("names a module for every file the entry reaches, and nothing else", () => {
    // All five are reachable from `index.astro`; the `.md` files and the `README` are
    // not modules at all, so nothing would name them either way.
    expect([...project.moduleNames.keys()].sort()).toEqual([
      "src/components/Header.astro",
      "src/components/Layout.astro",
      "src/lib/name.js",
      "src/pages/index.astro",
      "src/styles/site.css",
    ]);
  });

  test("leaves a module the entry cannot reach unnamed and out of the bundle", async () => {
    const orphaned = new Map(PROJECT);
    orphaned.set("src/components/Orphan.astro", "<p>nobody imports this</p>\n<style>p{}</style>\n");
    const pruned = await compileProject({ files: orphaned, entries: ENTRIES, compiler });
    expect(pruned.moduleNames.has("src/components/Orphan.astro")).toBe(false);
    expect(Object.keys(pruned.modules).sort()).toEqual(Object.keys(project.modules).sort());
  });

  test("reports the entries the bundle was built for", () => {
    expect(project.entries).toEqual(ENTRIES);
  });

  test("flattens every module to the bundle root, so `./name` always resolves", () => {
    for (const name of project.moduleNames.values()) expect(name).not.toContain("/");
    expect(project.moduleNames.get("src/pages/index.astro")).toStartWith("module-");
  });

  test("ships @pletivo/runtime alongside the project", () => {
    expect(project.modules["pletivo-runtime.js"]).toContain("renderAstroPage");
  });

  test("points compiled output at the runtime module", () => {
    expect(moduleCode(project, "src/pages/index.astro")).toContain('"./pletivo-runtime.js"');
  });

  test("rewrites a component import to its bundle name", () => {
    expect(moduleCode(project, "src/pages/index.astro")).toContain(
      `"./${project.moduleNames.get("src/components/Layout.astro")}"`,
    );
  });

  test("resolves a `.js` import and carries the module verbatim", () => {
    expect(moduleCode(project, "src/pages/index.astro")).toContain(
      `"./${project.moduleNames.get("src/lib/name.js")}"`,
    );
    expect(moduleCode(project, "src/lib/name.js")).toBe('export const NAME = "pletivo";\n');
  });

  test("resolves a side-effect CSS import to an empty module", () => {
    expect(moduleCode(project, "src/pages/index.astro")).toContain(
      `"./${project.moduleNames.get("src/styles/site.css")}"`,
    );
    expect(moduleCode(project, "src/styles/site.css")).toBe("export {};\n");
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
    expect(moduleCode(project, "src/components/Layout.astro")).toContain(`astro-${scope}`);
  });
});

describe("compileProject, demand-driven assets", () => {
  const imageInfo: ProjectAssetInfo = {
    width: 4,
    height: 4,
    format: "png",
    hash: "1234abcd",
  };

  function view(info: ProjectAssetsView["info"]): ProjectAssetsView {
    return { info, resolveOutput: () => null };
  }

  test("awaits an asynchronous asset view", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const assets = view(async (source) => {
      expect(source).toBe("src/assets/logo.png");
      started.resolve();
      await release.promise;
      return imageInfo;
    });
    const building = compileProject({
      files: new Map([
        ["src/pages/index.ts", 'import logo from "../assets/logo.png"; export default logo;\n'],
      ]),
      entries: ["src/pages/index.ts"],
      assets,
      compiler,
    });

    await started.promise;
    release.resolve();
    const built = await building;
    expect(moduleCode(built, "src/assets/logo.png")).toContain('src":"/_astro/logo.1234abcd.png"');
  });

  test("does not probe an image imported only by an unreached module", async () => {
    const probed: string[] = [];
    const assets = view((source) => {
      probed.push(source);
      return imageInfo;
    });
    await compileProject({
      files: new Map([
        ["src/pages/index.ts", "export default 'page';\n"],
        ["src/components/orphan.ts", 'import logo from "../assets/logo.png"; export default logo;\n'],
      ]),
      entries: ["src/pages/index.ts"],
      assets,
      compiler,
    });

    expect(probed).toEqual([]);
  });

  test("probes one canonical image source once across importers", async () => {
    const probed: string[] = [];
    const assets = view(async (source) => {
      probed.push(source);
      return imageInfo;
    });
    await compileProject({
      files: new Map([
        [
          "src/pages/index.ts",
          'import logo from "../assets/logo.png"; import "../components/card.ts"; export default logo;\n',
        ],
        ["src/components/card.ts", 'import logo from "../assets/logo.png"; export default logo;\n'],
      ]),
      entries: ["src/pages/index.ts"],
      assets,
      compiler,
    });

    expect(probed).toEqual(["src/assets/logo.png"]);
  });

  test("names missing metadata at the imported image", async () => {
    await expect(
      compileProject({
        files: new Map([
          ["src/pages/index.ts", 'import logo from "../assets/missing.png"; export default logo;\n'],
        ]),
        entries: ["src/pages/index.ts"],
        assets: view(() => null),
        compiler,
      }),
    ).rejects.toThrow(/src\/pages\/index\.ts.*image metadata is missing or unreadable/s);
  });
});

describe("compileProject, paths that flatten to the same name", () => {
  // `/` -> `_` is not injective, and these two are the smallest pair that shows it:
  // both flatten to `src_a_b.js`.
  const ALIKE: [string, string][] = [
    ["src/a/b.js", `export const B = 1;\n`],
    ["src/a_b.js", `export const C = 2;\n`],
  ];

  test("names each from its own path, so discovery order cannot move a name", async () => {
    const forward = await compileProject({ files: new Map(ALIKE), compiler });
    const reversed = await compileProject({ files: new Map([...ALIKE].reverse()), compiler });
    const nested = forward.moduleNames.get("src/a/b.js");
    const flat = forward.moduleNames.get("src/a_b.js");
    expect(nested).not.toBe(flat);
    // A compile pruned to one page's graph reaches files in an order of its own, and a
    // name that moved with it would give one program two bundles.
    expect(reversed.moduleNames.get("src/a/b.js")).toBe(nested);
    expect(reversed.moduleNames.get("src/a_b.js")).toBe(flat);
  });

  test("keeps a shared module's name when two pages reach it in opposite orders", async () => {
    // The same claim against the walk that made it necessary: two pruned compiles of
    // one project, reaching the pair by different routes. A name that moved with
    // discovery would give the shared modules two content addresses, and one program
    // two isolates.
    const files = new Map<string, string>([
      ...ALIKE,
      ["src/pages/one.astro", '---\nimport "../a/b.js";\nimport "../a_b.js";\n---\n<p>one</p>\n'],
      ["src/pages/two.astro", '---\nimport "../a_b.js";\nimport "../a/b.js";\n---\n<p>two</p>\n'],
    ]);
    const one = await compileProject({ files, entries: ["src/pages/one.astro"], compiler });
    const two = await compileProject({ files, entries: ["src/pages/two.astro"], compiler });
    for (const shared of ["src/a/b.js", "src/a_b.js"]) {
      expect([shared, two.moduleNames.get(shared)]).toEqual([
        shared,
        one.moduleNames.get(shared),
      ]);
    }
    // …and neither page is in the other's bundle, which is what the pruning is for.
    expect(one.moduleNames.has("src/pages/two.astro")).toBe(false);
    expect(two.moduleNames.has("src/pages/one.astro")).toBe(false);
  });
});

describe("compileProject, blocks in source order", () => {
  test("keeps a scoped block before the is:global one written after it", async () => {
    const one = await compileProject({
      files: new Map([
        [
          "src/pages/index.astro",
          `<div class="m">m</div>\n<style>.m { --a: 1; }</style>\n<style is:global>.g { --b: 2; }</style>\n`,
        ],
      ]),
      compiler,
    });
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
    const typed = await compileProject({ files: TYPED, compiler });
    for (const [name, source] of Object.entries(typed.modules)) {
      expect(() => asJavaScript.transformSync(source), name).not.toThrow();
    }
  });

  test("leaves no TypeScript for the isolate's diagnostic to find", async () => {
    const typed = await compileProject({ files: TYPED, compiler });
    expect(typescriptSuspects(typed.modules)).toEqual([]);
  });

  test("keeps the import graph the cascade order walks", async () => {
    const typed = await compileProject({ files: TYPED, compiler });
    // The component import survives; the `import type` does not, and never was an edge.
    expect(typed.imports.get("src/pages/index.astro")).toEqual(["src/components/Card.astro"]);
    expect(moduleCode(typed, "src/pages/index.astro")).toContain(
      `"./${typed.moduleNames.get("src/components/Card.astro")}"`,
    );
    expect(moduleCode(typed, "src/pages/index.astro")).not.toContain("../lib/types.ts");
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
    const a = await compileProject({ files: TYPED, compiler });
    const b = await compileProject({ files: untyped, compiler });
    const blank = (code: string): string =>
      code
        .split("\n")
        .filter((line) => line.trim() !== "")
        .join("\n");
    expect(blank(moduleCode(a, "src/pages/index.astro"))).toBe(
      blank(moduleCode(b, "src/pages/index.astro")),
    );
  });

  test("names the file when the frontmatter does not parse at all", () => {
    expect(
      compileProject({
        files: new Map([["src/pages/index.astro", "---\nconst = ;\n---\n<p>x</p>\n"]]),
        compiler,
      }),
    ).rejects.toThrow(/src\/pages\/index\.astro.*position is in the compiled output/s);
  });
});

describe("compileProject, refusals", () => {
  test("throws with the file name when the compiler reports an error", () => {
    expect(
      compileProject({ files: new Map([["src/pages/index.astro", "<slot name/>"]]), compiler }),
    ).rejects.toThrow(/src\/pages\/index\.astro.*slot\[name\] must be a static string/s);
  });

  test("says nothing about a broken file the entry cannot reach", async () => {
    // A behaviour change, on the record rather than discovered: a syntax error used to
    // fail every render of the project, because every render compiled every file. An
    // on-demand render never reads a module no page reaches. `pletivo build` on the Bun
    // host still compiles everything. See docs/todos/023 §10.
    const files = new Map([
      ["src/pages/index.astro", "<html><body><p>fine</p></body></html>\n"],
      ["src/components/Broken.astro", "<slot name/>"],
    ]);
    const pruned = await compileProject({ files, entries: ["src/pages/index.astro"], compiler });
    expect(pruned.moduleNames.has("src/components/Broken.astro")).toBe(false);
    // It is still loud the moment something reaches it.
    expect(
      compileProject({ files, entries: ["src/components/Broken.astro"], compiler }),
    ).rejects.toThrow(/slot\[name\] must be a static string/);
  });
});

describe("isExecutableModule", () => {
  test("names the extensions the isolate can be handed code for", () => {
    expect(
      ["a.astro", "a.tsx", "a.ts", "a.jsx", "a.mts", "a.cts", "a.js", "a.mjs", "a.json"].map(
        isExecutableModule,
      ),
    ).toEqual([true, true, true, true, true, true, true, true, true]);
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
    const built = await compileProject({ files, compiler });
    const page = moduleCode(built, "src/pages/index.astro");
    expect(page).toContain(`"./${built.moduleNames.get("src/layouts/Layout.astro")}"`);
    expect(page).toContain(`"./${built.moduleNames.get("src/lib/util/index.ts")}"`);
  });

  test("resolves `./x.js` to the `x.ts` it lands on — TypeScript's own convention", async () => {
    const built = await compileProject({ files, compiler });
    expect(moduleCode(built, "src/pages/index.astro")).toContain(
      `"./${built.moduleNames.get("src/lib/name.ts")}"`,
    );
  });

  test("keeps the import graph and the rewritten specifiers on the same edges", async () => {
    const built = await compileProject({ files, compiler });
    // The CSS cascade is ordered by this list, so a specifier the bundle resolves and
    // the graph does not would move a component's styles.
    expect(built.imports.get("src/pages/index.astro")).toEqual([
      "src/layouts/Layout.astro",
      "src/lib/name.ts",
      "src/lib/util/index.ts",
    ]);
  });

  test("fails loudly when no project file or artifact answers a specifier", async () => {
    await expect(
      compileProject({
        files: new Map([["src/pages/a.astro", `---\nimport "./missing";\n---\n<p>a</p>\n`]]),
        compiler,
      }),
    ).rejects.toThrow(/src\/pages\/a\.astro.*\.\/missing/);
  });
});
