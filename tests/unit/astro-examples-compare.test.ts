import { describe, expect, test } from "bun:test";
import { createHtmlNormalizer, normalizeVoidElements } from "../astro-examples/compare";

const VOID = ["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"];

describe("normalizeVoidElements", () => {
  test("drops the trailing slash of every void element, with or without a space before it", () => {
    for (const name of VOID) {
      expect(normalizeVoidElements(`<${name}/>`)).toBe(`<${name}>`);
      expect(normalizeVoidElements(`<${name} />`)).toBe(`<${name}>`);
      expect(normalizeVoidElements(`<${name} data-x="1"/>`)).toBe(`<${name} data-x="1">`);
      expect(normalizeVoidElements(`<${name} data-x="1" />`)).toBe(`<${name} data-x="1">`);
      expect(normalizeVoidElements(`<${name} data-x="1">`)).toBe(`<${name} data-x="1">`);
      expect(normalizeVoidElements(`<${name.toUpperCase()} hidden/>`)).toBe(`<${name.toUpperCase()} hidden>`);
    }
  });

  test("leaves a non-void element's slash", () => {
    expect(normalizeVoidElements("<div/>")).toBe("<div/>");
    expect(normalizeVoidElements('<span class="a" />')).toBe('<span class="a" />');
    expect(normalizeVoidElements("<metadata/>")).toBe("<metadata/>");
  });

  test("leaves void-named elements inside SVG and MathML as written", () => {
    const svg = '<svg viewBox="0 0 1 1"><link href="#a"/><img src="a.png"/><g><br/></g></svg>';
    expect(normalizeVoidElements(svg)).toBe(svg);
    const math = "<math><mi>x</mi><img/><mrow><hr /></mrow></math>";
    expect(normalizeVoidElements(math)).toBe(math);
    expect(normalizeVoidElements(`<svg><svg><br/></svg><br/></svg><br/>`)).toBe(`<svg><svg><br/></svg><br/></svg><br>`);
    expect(normalizeVoidElements(`<svg/><br/>`)).toBe(`<svg/><br>`);
  });

  test("reads quoted attribute values that hold a slash or a closing bracket", () => {
    expect(normalizeVoidElements('<meta content="a/b"/>')).toBe('<meta content="a/b">');
    expect(normalizeVoidElements('<img alt="x/>" src=\'y/>\' />')).toBe('<img alt="x/>" src=\'y/>\'>');
    expect(normalizeVoidElements('<img alt="x/>">')).toBe('<img alt="x/>">');
    expect(normalizeVoidElements('<meta content = "a/>b"/><p>t</p>')).toBe('<meta content = "a/>b"><p>t</p>');
  });

  test("keeps a slash that ends an unquoted attribute value: it is part of the value", () => {
    expect(normalizeVoidElements("<img src=a/>")).toBe("<img src=a/>");
    expect(normalizeVoidElements("<img src=a />")).toBe("<img src=a>");
  });

  test("leaves raw-text elements, comments and the doctype as written", () => {
    const raw = [
      "<pre><br/>a/b</pre>",
      "<textarea><img/></textarea>",
      '<script>const s = "<br/>";</script>',
      "<style>a::after{content:'<hr/>'}</style>",
      "<!-- a > b <br/> -->",
      "<!DOCTYPE html>",
    ].join("");
    expect(normalizeVoidElements(raw)).toBe(raw);
    expect(normalizeVoidElements("<pre><br/></pre><br/>")).toBe("<pre><br/></pre><br>");
  });

  test("leaves text with a bare < alone", () => {
    expect(normalizeVoidElements("<p>a < b</p><br/>")).toBe("<p>a < b</p><br>");
  });

  test("is part of the page normaliser", async () => {
    const normalize = createHtmlNormalizer(async (css) => css, () => false);
    expect(await normalize('<meta charset="utf-8"/><p>x</p>')).toBe(await normalize('<meta charset="utf-8"><p>x</p>'));
  });
});
