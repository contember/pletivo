import { describe, expect, test } from "bun:test";
import { canonicalPageCss, normalizeValue, parseCss, propertyFamilies, selectorListSpecificity } from "../astro-examples/css";
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

  test("the order of independent properties whose names share a logical alias", () => {
    same(["a{width:1px;height:1px}"], ["a{height:1px;width:1px}"]);
    same(["a{font-size:1em;line-height:2}"], ["a{line-height:2;font-size:1em}"]);
  });

  test("the order of rules that share no property family", () => {
    same(["html,body{margin:0}.message{text-align:center}"], [".message{text-align:center}html,body{margin:0}"]);
  });

  test("the order of rules that cannot tie: other specificity, importance or scope", () => {
    same(["strong,b{font-weight:700}a.active{font-weight:bolder}"], ["a.active{font-weight:bolder}strong,b{font-weight:700}"]);
    same(["a{color:red!important}a{color:blue}"], ["a{color:blue}a{color:red!important}"]);
    same(["@font-face{font-family:x}body{font-family:y}"], ["body{font-family:y}@font-face{font-family:x}"]);
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
    differ(["a{inline-size:1px;width:2px}"], ["a{width:2px;inline-size:1px}"]);
    differ(["a{inset:0;top:1px}"], ["a{top:1px;inset:0}"]);
    differ(["a{gap:0;row-gap:1px}"], ["a{row-gap:1px;gap:0}"]);
    differ(["a{word-wrap:normal;overflow-wrap:anywhere}"], ["a{overflow-wrap:anywhere;word-wrap:normal}"]);
  });

  test("the order of two rules setting one property", () => {
    differ([".a{color:red}.b{color:blue}"], [".b{color:blue}.a{color:red}"]);
    differ([".a{--x:1}.b{--x:2}"], [".b{--x:2}.a{--x:1}"]);
  });

  test("the order of rules that can tie on specificity", () => {
    differ(["a.x{color:red}b.y{color:blue}"], ["b.y{color:blue}a.x{color:red}"]);
    differ([".x,#y{color:red}#z{color:blue}"], ["#z{color:blue}.x,#y{color:red}"]);
    differ([":is(.x,#y){color:red}#z{color:blue}"], ["#z{color:blue}:is(.x,#y){color:red}"]);
    differ([":nth-child(2 of .x){color:red}.a.b{color:blue}"], [".a.b{color:blue}:nth-child(2 of .x){color:red}"]);
    differ(["@media (x){.a{color:red}}.b{color:blue}"], [".b{color:blue}@media (x){.a{color:red}}"]);
    differ(["@font-face{font-family:x;src:url(a)}@font-face{font-family:x;src:url(b)}"], ["@font-face{font-family:x;src:url(b)}@font-face{font-family:x;src:url(a)}"]);
  });

  test("the order of vendor-prefixed fallbacks", () => {
    differ(["a{display:-webkit-box;display:flex}"], ["a{display:flex;display:-webkit-box}"]);
  });

  test("@layer blocks and statement at-rules in place", () => {
    differ(["@layer a{x{color:red}}y{margin:0}"], ["y{margin:0}@layer a{x{color:red}}"]);
    differ(['@import "a.css";y{margin:0}'], ['y{margin:0}@import "a.css";']);
  });

  test("the order of rules in a layer, or in an at-rule it does not know, around a nested condition", () => {
    differ(["@layer a{.x{color:red}@media (y){.z{color:blue}}}"], ["@layer a{@media (y){.z{color:blue}}.x{color:red}}"]);
    differ(
      ["@layer u{.flex{display:flex}.sm\\:hidden{@media (width>=40rem){display:none}}}"],
      ["@layer u{.sm\\:hidden{@media (width>=40rem){display:none}}.flex{display:flex}}"],
    );
    differ(["@scope (.a){p{color:red}}@scope (.b){p{color:blue}}"], ["@scope (.b){p{color:blue}}@scope (.a){p{color:red}}"]);
    differ([".a{opacity:1}@starting-style{.a{opacity:0}}"], ["@starting-style{.a{opacity:0}}.a{opacity:1}"]);
  });

  test("the order of two descriptor blocks with one name", () => {
    differ(["@keyframes x{from{color:red}}@keyframes x{from{opacity:0}}"], ["@keyframes x{from{opacity:0}}@keyframes x{from{color:red}}"]);
    differ(["@property --x{syntax:'*'}@property --x{inherits:true}"], ["@property --x{inherits:true}@property --x{syntax:'*'}"]);
  });

  test("the case of custom properties and statement at-rules", () => {
    differ([":root{--Accent:red}"], [":root{--accent:red}"]);
    differ(['@import "/A.css";'], ['@import "/a.css";']);
    differ(["@layer A,B;"], ["@layer a,b;"]);
  });

  test("the order of aliases and their standard names", () => {
    differ(["a{grid-gap:0;row-gap:1px}"], ["a{row-gap:1px;grid-gap:0}"]);
    differ(["a{gap:0;grid-row-gap:1px}"], ["a{grid-row-gap:1px;gap:0}"]);
    differ(["a{color-adjust:exact;print-color-adjust:economy}"], ["a{print-color-adjust:economy;color-adjust:exact}"]);
  });

  test("the order around a selector the scorer gives up on", () => {
    differ(["svg|a{color:red}b{color:blue}"], ["b{color:blue}svg|a{color:red}"]);
    differ([":host(.x){color:red}.a.b{color:blue}"], [".a.b{color:blue}:host(.x){color:red}"]);
  });

  test("the rules after a stray closing brace", () => {
    differ(["a{color:red}}b{color:blue}"], ["a{color:red}"]);
    differ(["a{color:red}}b{color:blue}"], ["a{color:red}b{color:blue}"]);
  });

  test("a different value", () => {
    differ(["a{color:red}"], ["a{color:blue}"]);
    differ(["html{font-family:system-ui}"], ["html{font-family:system-ui,sans-serif}"]);
    differ([":root{--x:a b}"], [":root{--x:ab}"]);
    differ(["html{font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Noto Sans,Ubuntu,Cantarell,Helvetica Neue Light}"], ["html{font-family:system-ui Light}"]);
    differ(['@font-face{src:url(/a.woff2)format("woff2-variations")}'], ["@font-face{src:url(/a.woff2)format(woff2-variations)}"]);
  });
});

describe("selectorListSpecificity", () => {
  test("scores ids, classes, attributes, pseudo-classes, types and pseudo-elements", () => {
    expect(selectorListSpecificity("#a .b[c]:hover p::before")).toEqual(new Set(["1,3,2"]));
    expect(selectorListSpecificity("a:before,*")).toEqual(new Set(["0,0,2", "0,0,0"]));
    expect(selectorListSpecificity(":where(#a) .b")).toEqual(new Set(["0,1,0"]));
    expect(selectorListSpecificity(":not(#a,.b) c")).toEqual(new Set(["1,0,1"]));
  });

  test("gives up on what it does not score", () => {
    expect(selectorListSpecificity(".a\\:b")).toBeNull();
    expect(selectorListSpecificity("li:nth-child(2 of .x)")).toBeNull();
    expect(selectorListSpecificity("::slotted(p)")).toBeNull();
    expect(selectorListSpecificity("svg|a")).toBeNull();
    expect(selectorListSpecificity(":host-context(.x)")).toBeNull();
  });

  test("reads a non-ASCII name", () => {
    expect(selectorListSpecificity(".é ü")).toEqual(new Set(["0,1,1"]));
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

  test("keeps page CSS in order against CSS left in the markup", async () => {
    const normalize = createHtmlNormalizer(css, astroBundle, () => null);
    const external = '<link rel="stylesheet" href="https://fonts.example/x.css">';
    const page = "<style>.x{color:red}</style>";
    expect(await normalize(external + page)).not.toBe(await normalize(page + external));
    const print = '<style media="print">.x{color:blue}</style>';
    expect(await normalize(print + page)).not.toBe(await normalize(page + print));
  });

  test("leaves a <style> where it does not apply", async () => {
    const normalize = createHtmlNormalizer(css, pletivoBundle, () => null);
    const style = "<style>.x{color:red}</style>";
    for (const [open, close] of [["<template>", "</template>"], ["<!--", "-->"], ['<script>s="', '"</script>']]) {
      expect(await normalize(`${open}${style}${close}`)).not.toBe(await normalize(`${open}${close}${style}`));
    }
  });

  test("does not read in a disabled link", async () => {
    const normalize = createHtmlNormalizer(css, astroBundle, () => "a{color:red}");
    expect(await normalize('<link rel="stylesheet" href="/_astro/x.Ab12Cd34.css" disabled>')).toContain("<link");
  });

  test("keeps a link it cannot read, and one with a media query", async () => {
    const normalize = createHtmlNormalizer(css, astroBundle, () => "a{color:red}");
    expect(await normalize('<link rel="stylesheet" href="/_astro/x.Ab12Cd34.css" media="print">')).toContain("media=");
    const unread = createHtmlNormalizer(css, astroBundle, () => null);
    expect(await unread('<link rel="stylesheet" href="/_astro/x.Ab12Cd34.css">')).toContain("<link");
  });
});
