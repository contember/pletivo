import { describe, expect, test } from "bun:test";
import { cssImports, cssPreludeRules, cssUrlTokens, withoutCssImports } from "@pletivo/core/css-imports";

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

describe("cssPreludeRules", () => {
  test("reports each @import and @charset with its span through the semicolon and its conditions", () => {
    const source =
      '@charset "utf-8";\n/* @import "./no.css"; */\n@import "./a.css";\n@import url(b.css) layer(base) screen;\n.rule { color: red; }\n';
    const rules = cssPreludeRules(source);
    expect(rules.map((rule) => [rule.name, rule.target, rule.conditions])).toEqual([
      ["charset", "utf-8", ""],
      ["import", "./a.css", ""],
      ["import", "b.css", "layer(base) screen"],
    ]);
    expect(rules.map((rule) => source.slice(rule.start, rule.end))).toEqual([
      '@charset "utf-8";',
      '@import "./a.css";',
      "@import url(b.css) layer(base) screen;",
    ]);
  });
});

describe("cssUrlTokens", () => {
  test("finds url() tokens with their spans, and none in a comment or a string", () => {
    const source =
      '/* url(./comment.svg) */ .a { background: url( "./a.svg" ), url(b.png); content: "url(./string.svg)"; }';
    const tokens = cssUrlTokens(source);
    expect(tokens.map((token) => token.target)).toEqual(["./a.svg", "b.png"]);
    expect(tokens.map((token) => source.slice(token.start, token.end))).toEqual(['url( "./a.svg" )', "url(b.png)"]);
  });

  test("takes a url( only where a word ends, as the regex it replaces did", () => {
    expect(cssUrlTokens("a{b:xurl(x.png) -url(y.png) URL(z.png)}").map((token) => token.target)).toEqual(["y.png"]);
  });

  test("ends a string a newline breaks at that newline", () => {
    expect(cssUrlTokens(".a { content: 'broken\n; background: url(./after.svg); }").map((token) => token.target)).toEqual([
      "./after.svg",
    ]);
  });
});
