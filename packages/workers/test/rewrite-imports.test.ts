import { describe, expect, test } from "bun:test";
import { createAstroCompiler } from "../src/astro-compiler.ts";
import {
  collectSpecifiers,
  prologueEnd,
  resolveSpecifier,
  rewriteImports,
} from "../src/rewrite-imports.ts";
import { astroWasmModule } from "./astro-wasm.ts";

/** The module graph a worker host would hold: project path -> name in the bundle. */
const PROJECT: Record<string, string> = {
  "src/components/Layout.astro": "./Layout.astro.js",
  "src/components/Doc.astro": "./Doc.astro.js",
  "src/pages/side-effect.css": "./side-effect.css.js",
  "src/pages/lazy.ts": "./lazy.ts.js",
};

const options = (importer: string) => ({
  importer,
  resolve: (resolved: string) => PROJECT[resolved] ?? null,
});

describe("resolveSpecifier", () => {
  test("climbs out of the importer's directory", () => {
    expect(resolveSpecifier("src/pages/index.astro", "../components/Layout.astro")).toBe(
      "src/components/Layout.astro",
    );
  });

  test("stays in the importer's directory", () => {
    expect(resolveSpecifier("src/pages/index.astro", "./styles.css")).toBe("src/pages/styles.css");
    expect(resolveSpecifier("src/pages/index.astro", "./a/../b.ts")).toBe("src/pages/b.ts");
  });

  test("leaves bare and absolute specifiers alone", () => {
    expect(resolveSpecifier("src/pages/index.astro", "pletivo/astro-shim")).toBe(
      "pletivo/astro-shim",
    );
    expect(resolveSpecifier("src/pages/index.astro", "/abs/x.ts")).toBe("/abs/x.ts");
  });

  test("keeps a query suffix on the resolved path", () => {
    expect(resolveSpecifier("src/pages/index.astro", "./a.astro?astro&type=style")).toBe(
      "src/pages/a.astro?astro&type=style",
    );
  });

  test("drops a climb past the root instead of producing a parent path", () => {
    expect(resolveSpecifier("index.astro", "../../x.ts")).toBe("x.ts");
  });
});

describe("prologueEnd", () => {
  test("covers a run of imports, comments and blank lines", () => {
    const code = `// header\nimport a from "./a.ts";\n\n/* block */\nimport "./b.css";\nexport { c } from "./c.ts";\nconst d = 1;\nimport e from "./e.ts";\n`;
    expect(code.slice(0, prologueEnd(code))).toBe(
      `// header\nimport a from "./a.ts";\n\n/* block */\nimport "./b.css";\nexport { c } from "./c.ts";\n`,
    );
  });

  test("covers a multi-line named import block", () => {
    const code = `import {\n  a,\n  b as c,\n} from "./x.ts";\nconst d = 1;\n`;
    expect(prologueEnd(code)).toBe(code.indexOf("const d"));
  });

  test("is empty when the module opens with something else", () => {
    expect(prologueEnd(`const a = 1;\nimport b from "./b.ts";\n`)).toBe(0);
  });
});

describe("collectSpecifiers", () => {
  test("keeps prologue imports in source order, dynamic ones after", () => {
    const code = `import a from "./a.ts";\nimport "./b.css";\nexport { c } from "./c.ts";\nconst d = () => import("./d.ts");\n`;
    expect(collectSpecifiers(code)).toEqual(["./a.ts", "./b.css", "./c.ts", "./d.ts"]);
  });

  test("stops where rewriteImports stops, so the two see the same graph", () => {
    const code = `import a from "./a.ts";\nconst x = 1;\nimport b from "./b.ts";\n`;
    expect(collectSpecifiers(code)).toEqual(["./a.ts"]);
  });

  test("reads a multi-line named import as one specifier", () => {
    expect(collectSpecifiers(`import {\n  a,\n  b as c,\n} from "./x.ts";\n`)).toEqual(["./x.ts"]);
  });
});

describe("rewriteImports", () => {
  test("leaves specifiers the resolver does not claim", () => {
    const code = `import x from "./unknown.ts";\nimport y from "some-package";\n`;
    expect(rewriteImports(code, options("src/pages/index.astro"))).toBe(code);
  });

  test("rewrites a multi-line named import block", () => {
    const code = `import {\n  a,\n  b as c,\n} from "../components/Layout.astro";\n`;
    expect(rewriteImports(code, options("src/pages/index.astro"))).toBe(
      `import {\n  a,\n  b as c,\n} from "./Layout.astro.js";\n`,
    );
  });

  test("rewrites `export ... from`", () => {
    const code = `export * from "../components/Doc.astro";\n`;
    expect(rewriteImports(code, options("src/pages/index.astro"))).toBe(
      `export * from "./Doc.astro.js";\n`,
    );
  });

  test("rewrites a dynamic import inside a function body", () => {
    const code = `import a from "../components/Doc.astro";\nconst f = () => import("./lazy.ts");\n`;
    expect(rewriteImports(code, options("src/pages/index.astro"))).toBe(
      `import a from "./Doc.astro.js";\nconst f = () => import("./lazy.ts.js");\n`,
    );
  });
});

describe("rewriteImports over real compiler output", () => {
  // Frontmatter imports interleaved with statements (the compiler hoists them), plus
  // page copy that looks exactly like an import statement at column 0.
  const source = `---
const before = 1;
import Layout from "../components/Layout.astro";
const after = 2;
import "./side-effect.css";
const lazy = () => import("./lazy.ts");
---
<Layout>
import Doc from "../components/Doc.astro";
export * from "../components/Doc.astro";
{before}{after}{lazy}
</Layout>
`;

  test("rewrites every real import and no page copy", async () => {
    const compiler = createAstroCompiler(await astroWasmModule());
    const { code } = await compiler.transform(source, {
      filename: "src/pages/index.astro",
      internalURL: "pletivo/astro-shim",
      sourcemap: false,
    });
    const out = rewriteImports(code, options("src/pages/index.astro"));

    expect(out).toContain(`import Layout from "./Layout.astro.js";`);
    expect(out).toContain(`import "./side-effect.css.js";`);
    expect(out).toContain(`import("./lazy.ts.js")`);
    // The shim import is bare, so the resolver never sees a project path for it.
    expect(out).toContain(`} from "pletivo/astro-shim";`);

    // Page copy, still verbatim inside the template literal.
    expect(out).toContain(`import Doc from "../components/Doc.astro";`);
    expect(out).toContain(`export * from "../components/Doc.astro";`);
    expect(out).not.toContain(`"./Doc.astro.js"`);
  });
});
