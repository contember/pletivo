import { describe, expect, test } from "bun:test";
import { cssImports, withoutCssImports } from "@pletivo/core/css-imports";

describe("withoutCssImports", () => {
  test("removes each @import cssImports finds, conditions and all, through its semicolon", () => {
    const source =
      '@import "./a.css";\n@import url(./b.css) screen and (min-width: 1px);\n@IMPORT url("c.css") layer(base) supports(display: grid);\n.rule { color: red; }\n';
    expect(cssImports(source)).toEqual(["./a.css", "./b.css", "c.css"]);
    expect(withoutCssImports(source)).toBe("\n\n\n.rule { color: red; }\n");
  });

  test("keeps an @import in a comment or a string, and every other at-rule", () => {
    const source =
      '/* @import "./a.css"; */\n@charset "utf-8";\n@layer base;\n.q::before { content: \'@import "./b.css";\'; }\n';
    expect(withoutCssImports(source)).toBe(source);
  });

  test("stops at the block of a rule an unterminated @import runs into", () => {
    expect(withoutCssImports('@import "./a.css"\n}\n.next { color: red; }')).toBe("}\n.next { color: red; }");
  });
});
