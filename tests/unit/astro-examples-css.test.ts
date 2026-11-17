import { describe, expect, test } from "bun:test";
import { canonicalPageCss, normalizeValue, parseCss, propertyFamilies } from "../astro-examples/css";
import { createHtmlNormalizer, pletivoBundle, astroBundle } from "../astro-examples/compare";

const same = (a: string[], b: string[]) => expect(canonicalPageCss(a)).toEqual(canonicalPageCss(b));
const differ = (a: string[], b: string[]) => expect(canonicalPageCss(a)).not.toEqual(canonicalPageCss(b));

describe("parseCss", () => {
  test("reads blocks, nested blocks and declarations; strings and parentheses are opaque", () => {
    expect(parseCss('a{b:url(x;y);content:"}{;"}@media (x){c{d:1}}')).toEqual([
      {
        kind: "block",
        prelude: "a",
        children: [
          { kind: "declaration", property: "b", value: "url(x;y)" },
          { kind: "declaration", property: "content", value: '"}{;"' },
        ],
      },
      {
        kind: "block",
        prelude: "@media (x)",
        children: [{ kind: "block", prelude: "c", children: [{ kind: "declaration", property: "d", value: "1" }] }],
      },
    ]);
  });
});

describe("canonicalPageCss: what it erases", () => {
  test("the order of declarations of unrelated properties", () => {
    same([".c{display:grid;font-size:2em;margin-top:2em}"], [".c{margin-top:2em;font-size:2em;display:grid}"]);
  });

  test("the order of rules that share no property family", () => {
    same(["html,body{margin:0}.message{text-align:center}"], [".message{text-align:center}html,body{margin:0}"]);
  });

  test("how the CSS is split into sheets", () => {
    same(["a{color:red}", "b{color:blue}"], ["a{color:red}b{color:blue}"]);
  });

  test("Bun's spelling of equal values", () => {
    same([":root{--accent: #2337ff;--black: 15, 18, 25}"], [":root{--accent:#2337ff;--black:15,18,25}"]);
    same(["body{background:linear-gradient(red) no-repeat}"], ["body{background:linear-gradient(red)no-repeat}"]);
    same(['@font-face{src:url(/a.woff) format("woff")}'], ["@font-face{src:url(/a.woff)format(woff)}"]);
    same(
      ["html{font-family:system-ui}"],
      ["html{font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Noto Sans,Ubuntu,Cantarell,Helvetica Neue}"],
    );
  });
});

describe("canonicalPageCss: what it keeps", () => {
  test("a rule present on one side only, wherever it sits", () => {
    differ(["a{color:red}b{margin:0}"], ["a{color:red}"]);
    differ(["a{color:red}"], ["a{color:red}a{color:red}"]);
    differ(["@media (x){a{color:red}}"], ["@media (x){}"]);
  });

  test("the order of a shorthand and its longhand, in a rule and across rules", () => {
    differ(["a{margin:0;margin-top:1px}"], ["a{margin-top:1px;margin:0}"]);
    differ(["a{margin:0}b{margin-top:1px}"], ["b{margin-top:1px}a{margin:0}"]);
    differ(["a{place-items:center;align-items:start}"], ["a{align-items:start;place-items:center}"]);
    differ(["a{font:12px x;line-height:2}"], ["a{line-height:2;font:12px x}"]);
  });

  test("the order of two rules setting one property", () => {
    differ([".a{color:red}.b{color:blue}"], [".b{color:blue}.a{color:red}"]);
    differ([".a{--x:1}.b{--x:2}"], [".b{--x:2}.a{--x:1}"]);
  });

  test("the order of vendor-prefixed fallbacks", () => {
    differ(["a{display:-webkit-box;display:flex}"], ["a{display:flex;display:-webkit-box}"]);
  });

  test("@layer blocks and statement at-rules in place", () => {
    differ(["@layer a{x{color:red}}y{margin:0}"], ["y{margin:0}@layer a{x{color:red}}"]);
    differ(['@import "a.css";y{margin:0}'], ['y{margin:0}@import "a.css";']);
  });

  test("a different value", () => {
    differ(["a{color:red}"], ["a{color:blue}"]);
    differ(["html{font-family:system-ui}"], ["html{font-family:system-ui,sans-serif}"]);
    differ([":root{--x:a b}"], [":root{--x:ab}"]);
  });
});

describe("normalizeValue and propertyFamilies", () => {
  test("keeps strings as written", () => {
    expect(normalizeValue("content", '" , "')).toBe('" , "');
  });

  test("keeps whitespace before an operator after a parenthesis", () => {
    expect(normalizeValue("width", "calc((1px) + 2px)")).toBe("calc((1px) + 2px)");
  });

  test("links shorthands, aliases and logical sides", () => {
    expect(propertyFamilies("-webkit-mask-image")).toEqual(["mask"]);
    expect(propertyFamilies("inset-block-start")).toContain("top");
    expect(propertyFamilies("all")).toEqual(["*"]);
  });
});

describe("the page normaliser", () => {
  const css = async (text: string) => text;
  test("compares a linked bundled sheet as if inlined, and page CSS wherever it sits", async () => {
    const files: Record<string, string> = { "/_astro/index.Ab12Cd34.css": "a{color:red}" };
    const astro = createHtmlNormalizer(css, astroBundle, (url) => files[url] ?? null);
    const pletivo = createHtmlNormalizer(css, pletivoBundle, () => null);
    const linked = await astro('<html><head><link rel="stylesheet" href="/_astro/index.Ab12Cd34.css"></head><body><p>x</p></body></html>');
    const inlined = await pletivo("<html><head></head><body><style>a{color:red}</style><p>x</p></body></html>");
    expect(linked).toBe(inlined);
    expect(linked).toContain("<style>\na{color:red}\n</style>");
  });

  test("keeps a link it cannot read, and one with a media query", async () => {
    const normalize = createHtmlNormalizer(css, astroBundle, () => "a{color:red}");
    expect(await normalize('<link rel="stylesheet" href="/_astro/x.Ab12Cd34.css" media="print">')).toContain("media=");
    const unread = createHtmlNormalizer(css, astroBundle, () => null);
    expect(await unread('<link rel="stylesheet" href="/_astro/x.Ab12Cd34.css">')).toContain("<link");
  });
});
