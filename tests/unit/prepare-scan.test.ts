import { describe, expect, test } from "bun:test";
import {
  classifySpecifier,
  importableSource,
  specifierUses,
  specifiersOf,
} from "../../packages/pletivo/src/prepare/scan";

/**
 * What `pletivo prepare` decides to go looking for. Everything downstream — resolving,
 * bundling, freezing — is driven by these two answers, so a specifier read out of a
 * code block or a hook that never runs shows up here first.
 */

describe("importableSource", () => {
  test("reads an .astro file's frontmatter and nothing below it", () => {
    const source = `---
import Layout from "../layouts/Layout.astro";
---
<pre>import evil from "not-a-dependency";</pre>
`;
    expect(specifiersOf("src/pages/a.astro", source)).toEqual(["../layouts/Layout.astro"]);
  });

  test("gives an .astro file with no frontmatter nothing", () => {
    expect(importableSource("src/pages/a.astro", `<p>x</p>\n`)).toBe("");
  });

  test("does not mistake a template's horizontal rule for frontmatter", () => {
    const source = `<article>\n---\nimport nope from "ghost";\n---\n</article>\n`;
    expect(specifiersOf("src/pages/a.astro", source)).toEqual([]);
  });

  test("reads a .ts file whole, and drops its type-only imports", () => {
    const source = `import type { A } from "astro";\nimport { z } from "zod";\n`;
    expect(specifiersOf("src/lib/a.ts", source)).toEqual(["zod"]);
  });

  test("does not treat Bun's JSX lowering helpers as source imports", () => {
    const source = `import { value } from "real-package";\nexport const Page = () => <p>{value}</p>;\n`;
    expect(specifiersOf("src/pages/index.tsx", source)).toEqual(["real-package"]);
  });

  test("contributes nothing for a file that is not a module", () => {
    expect(importableSource("src/data/x.json", "{}")).toBeNull();
    expect(specifiersOf("src/data/x.json", "{}")).toEqual([]);
  });

  test("reads CSS import edges without treating url assets as modules", () => {
    const source = `
/* @import "not-real.css"; */
body::before { content: '@import "also-not-real.css"'; }
@import "./reset.css";
@import url('theme-package');
@import URL(theme\\2d wide.css) screen;
a { background: url('./dot.png') }
`;
    expect(specifiersOf("src/styles/app.css", source)).toEqual([
      "./reset.css",
      "theme-package",
      "theme-wide.css",
    ]);
  });

  test("propagates malformed modules and rejects CommonJS syntax", () => {
    expect(() => specifiersOf("node_modules/bad/index.ts", "export const = ;")).toThrow(
      /could not parse imports/,
    );
    expect(() => specifiersOf("node_modules/cjs/index.js", "module.exports = 1")).toThrow(
      /CommonJS/,
    );
    expect(() => specifiersOf("node_modules/cjs/index.cjs", "exports.value = 1")).toThrow(
      /CommonJS \.cjs/,
    );
    expect(() => specifiersOf("node_modules/cjs/index.cts", "export = 1")).toThrow(
      /CommonJS \.cts/,
    );
    expect(specifiersOf(
      "node_modules/esm/index.js",
      `const text = "module.exports require('x')"; const pattern = /exports\\.value/;`,
    )).toEqual([]);
  });
});

describe("classifySpecifier", () => {
  test("leaves alone what the Workers host already answers", () => {
    expect(classifySpecifier("astro:content")).toBe("host");
    expect(classifySpecifier("astro/loaders")).toBe("host");
    expect(classifySpecifier("astro:env/server")).toBe("host");
    // The host worker holds the bytes, so it can read an image's dimensions itself.
    expect(classifySpecifier("astro:assets")).toBe("host");
  });

  test("separates Node built-ins for fatal producer validation", () => {
    expect(classifySpecifier("node:crypto")).toBe("builtin");
    expect(classifySpecifier("path")).toBe("builtin");
  });

  test("names the Astro virtual modules no Worker can serve", () => {
    expect(classifySpecifier("astro:transitions")).toBe("unsupported");
    expect(classifySpecifier("astro:middleware")).toBe("unsupported");
  });

  test("separates a Vite virtual module from an npm package", () => {
    expect(classifySpecifier("virtual:astro-icon")).toBe("virtual");
    expect(classifySpecifier("\0virtual:astro-icon")).toBe("virtual");
    expect(classifySpecifier("astro-icon/components")).toBe("vendor");
    expect(classifySpecifier("@iconify/utils")).toBe("vendor");
  });

  test("ignores anything a file map can resolve on its own", () => {
    expect(classifySpecifier("./Header.astro")).toBe("relative");
    expect(classifySpecifier("../lib/a.ts")).toBe("relative");
  });
});

describe("specifierUses", () => {
  test("reads the export names a package is imported for", () => {
    const uses = specifierUses("src/a.ts", `import { getIconData, iconToSVG as build } from "@iconify/utils";\n`);
    expect(uses.get("@iconify/utils")).toEqual({
      names: new Set(["getIconData", "iconToSVG"]),
      whole: false,
    });
  });

  test("counts a default import as a name of its own", () => {
    const uses = specifierUses("src/a.ts", `import marked, { parse } from "marked";\n`);
    expect(uses.get("marked")?.names).toEqual(new Set(["default", "parse"]));
  });

  test("gives up on names for a namespace import or a dynamic one", () => {
    expect(specifierUses("src/a.ts", `import * as all from "x";\n`).get("x")?.whole).toBe(true);
    expect(specifierUses("src/a.ts", `const m = await import("y");\n`).get("y")?.whole).toBe(true);
  });

  test("records a side-effect import, which names nothing and still has to be carried", () => {
    const uses = specifierUses("src/a.ts", `import "@fontsource/inter/400.css";\n`);
    expect(uses.get("@fontsource/inter/400.css")).toEqual({ names: new Set(), whole: false });
  });

  test("merges the two forms across one file", () => {
    const uses = specifierUses("src/a.ts", `import { a } from "x";\nexport { b } from "x";\n`);
    expect(uses.get("x")?.names).toEqual(new Set(["a", "b"]));
  });
});
