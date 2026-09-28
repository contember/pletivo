import { describe, expect, test } from "bun:test";
import { createAstroCompiler } from "../src/astro-compiler.ts";
import {
  collectImportedNames,
  collectSpecifiers,
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

describe("collectSpecifiers", () => {
  test("loads and scans with the Bun global absent", async () => {
    const savedBun: unknown = Reflect.get(globalThis, "Bun");
    Reflect.deleteProperty(globalThis, "Bun");
    try {
      const withoutBun = await import("../src/rewrite-imports.ts?without-bun");
      expect(withoutBun.collectSpecifiers(`import value from "./value.js";`)).toEqual([
        "./value.js",
      ]);
    } finally {
      Reflect.set(globalThis, "Bun", savedBun);
    }
  });

  test("keeps static and dynamic imports in source order", () => {
    const code = `import a from "./a.ts";\nimport "./b.css";\nexport { c } from "./c.ts";\nconst d = () => import("./d.ts");\n`;
    expect(collectSpecifiers(code)).toEqual(["./a.ts", "./b.css", "./c.ts", "./d.ts"]);
  });

  test("finds valid static imports after statements", () => {
    const code = `import a from "./a.ts";\nconst x = 1;\nimport b from "./b.ts";\n`;
    expect(collectSpecifiers(code)).toEqual(["./a.ts", "./b.ts"]);
  });

  test("reads a multi-line named import as one specifier", () => {
    expect(collectSpecifiers(`import {\n  a,\n  b as c,\n} from "./x.ts";\n`)).toEqual(["./x.ts"]);
  });

  test("ignores import-like strings, comments and template text", () => {
    const code = `const a = 'import x from "./fake-a.ts"';\n// import y from "./fake-b.ts"\n/* import "./fake-c.ts" */\nconst html = \`import z from "./fake-d.ts"\`;\nconst pattern = /import fake from "fake-e"/;\nimport real from "./a.ts";\n`;
    expect(collectSpecifiers(code)).toEqual(["./a.ts"]);
  });

  test("ignores import identifiers that are not module syntax", () => {
    const code = `const value = object.import("./method.ts");\nconst record = { import: "./key.ts" };\nimport "./real.ts";\n`;
    expect(collectSpecifiers(code)).toEqual(["./real.ts"]);
  });

  test("decodes escaped module specifiers like the JavaScript parser", () => {
    expect(collectSpecifiers(`import "./\\u0061.ts";\n`)).toEqual(["./a.ts"]);
  });

  test("finds dynamic imports inside template expressions but not template text", () => {
    const code = `const value = \`copy import("./fake.ts") ${"${"}import("./lazy.ts")}\`;\n`;
    expect(collectSpecifiers(code)).toEqual(["./lazy.ts"]);
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

  test("rewrites imports after statements without touching import-like text", () => {
    const code = `const copy = 'import x from "../components/Doc.astro"';\n// import y from "../components/Doc.astro"\nimport actual from "../components/Doc.astro";\n`;
    expect(rewriteImports(code, options("src/pages/index.astro"))).toBe(
      `const copy = 'import x from "../components/Doc.astro"';\n// import y from "../components/Doc.astro"\nimport actual from "./Doc.astro.js";\n`,
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

describe("collectImportedNames", () => {
  test("gives the exported name, not the local one", () => {
    const code = `import { API_BASE, TOKEN as t } from "astro:env/server";\n`;
    // `t` is this module's name for it; the generated module has to export `TOKEN`.
    expect(collectImportedNames(code, "astro:env/server")).toEqual(["API_BASE", "TOKEN"]);
  });

  test("names nothing for a namespace or default import, because neither does", () => {
    expect(collectImportedNames(`import * as env from "astro:env/server";\n`, "astro:env/server"))
      .toEqual([]);
    expect(collectImportedNames(`import env from "astro:env/server";\n`, "astro:env/server"))
      .toEqual([]);
  });

  test("ignores page copy inside a compiled template literal", () => {
    const code = `import { A } from "astro:env/server";
const html = \`
import { LEAKED } from "astro:env/server";
\`;
`;
    expect(collectImportedNames(code, "astro:env/server")).toEqual(["A"]);
  });

  test("ignores every other specifier", () => {
    const code = `import { A } from "astro:env/client";\nimport { B } from "astro:env/server";\n`;
    expect(collectImportedNames(code, "astro:env/server")).toEqual(["B"]);
  });
});
