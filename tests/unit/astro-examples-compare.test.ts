import { describe, expect, test } from "bun:test";
import { createHtmlNormalizer, normalizeAttributeSpelling, normalizeVoidElements } from "../astro-examples/compare";

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
      "<title>a<br/>b</title>",
      "<!-- a > b <br/> -->",
      "<!DOCTYPE html>",
    ].join("");
    expect(normalizeVoidElements(raw)).toBe(raw);
    expect(normalizeVoidElements("<pre><br/></pre><br/>")).toBe("<pre><br/></pre><br>");
    expect(normalizeVoidElements("<title><br/></title><br/>")).toBe("<title><br/></title><br>");
  });

  test("rewrites tags inside <noscript>: with scripting off, where it renders, they are markup", () => {
    expect(normalizeVoidElements('<noscript><img src="x"/></noscript>')).toBe('<noscript><img src="x"></noscript>');
  });

  test("leaves text with a bare < alone", () => {
    expect(normalizeVoidElements("<p>a < b</p><br/>")).toBe("<p>a < b</p><br>");
  });

  test("is part of the page normaliser", async () => {
    const normalize = createHtmlNormalizer(async (css) => css, () => false);
    expect(await normalize('<meta charset="utf-8"/><p>x</p>')).toBe(await normalize('<meta charset="utf-8"><p>x</p>'));
  });
});

describe("normalizeAttributeSpelling", () => {
  test("writes an empty attribute value as a bare attribute", () => {
    expect(normalizeAttributeSpelling('<pre data-seen="">x</pre>')).toBe("<pre data-seen>x</pre>");
    expect(normalizeAttributeSpelling("<code is:raw='' class=\"a\">x</code>")).toBe('<code is:raw class="a">x</code>');
    expect(normalizeAttributeSpelling('<input disabled = "" >')).toBe("<input disabled >");
    expect(normalizeAttributeSpelling('<img alt=""/>')).toBe("<img alt/>");
    expect(normalizeAttributeSpelling("<pre data-seen>x</pre>")).toBe("<pre data-seen>x</pre>");
    expect(normalizeAttributeSpelling('<a download title="" data-x="" href="/">x</a>')).toBe('<a download title data-x href="/">x</a>');
  });

  test("keeps a dropped empty value's attribute apart from an attribute written right after it", () => {
    expect(normalizeAttributeSpelling('<a title=""href="x">t</a>')).toBe('<a title href="x">t</a>');
    expect(normalizeAttributeSpelling("<a title=''data-x=''>t</a>")).toBe("<a title data-x>t</a>");
  });

  test("leaves a non-empty value, and a value that only looks empty, as written", () => {
    expect(normalizeAttributeSpelling('<a title=" ">x</a>')).toBe('<a title=" ">x</a>');
    expect(normalizeAttributeSpelling('<a title=\'""\'>x</a>')).toBe('<a title=\'""\'>x</a>');
    expect(normalizeAttributeSpelling('<a title="x=&quot;&quot;">x</a>')).toBe('<a title="x=&quot;&quot;">x</a>');
  });

  test("writes a quote character reference in a value as &quot;", () => {
    expect(normalizeAttributeSpelling('<code metastring="title=&#34;a/b.js&#34;">x</code>')).toBe(
      '<code metastring="title=&quot;a/b.js&quot;">x</code>',
    );
    expect(normalizeAttributeSpelling("<a title='&#34;' data-x=&#34;y>x</a>")).toBe("<a title='&quot;' data-x=&quot;y>x</a>");
    expect(normalizeAttributeSpelling('<a title="&#345;">x</a>')).toBe('<a title="&#345;">x</a>');
  });

  test("reads quoted values that hold > or /", () => {
    expect(normalizeAttributeSpelling('<img alt="a>b" title="" src="x/y">')).toBe('<img alt="a>b" title src="x/y">');
    expect(normalizeAttributeSpelling('<a href="/x" title="&#34;>">t</a>')).toBe('<a href="/x" title="&quot;>">t</a>');
  });

  test("leaves text content, comments and text-content elements as written", () => {
    const text = [
      '<p>data-seen="" and &#34;</p>',
      '<!-- <a title=""> -->',
      '<script>const a = "<b data-x=\\"\\">&#34;";</script>',
      '<style>a[title=""]::after{content:"&#34;"}</style>',
      '<textarea><b title=""></b></textarea>',
      '<title><b title=""></b>&#34;</title>',
    ].join("");
    expect(normalizeAttributeSpelling(text)).toBe(text);
    expect(normalizeAttributeSpelling('<script data-x="">a=""</script><b title="">')).toBe('<script data-x>a=""</script><b title>');
  });

  test("rewrites tags inside <pre>, whose content is markup", () => {
    expect(normalizeAttributeSpelling('<pre><code is:raw="" title="&#34;">x=""</code></pre>')).toBe(
      '<pre><code is:raw title="&quot;">x=""</code></pre>',
    );
    expect(normalizeAttributeSpelling('<noscript><img alt=""></noscript>')).toBe("<noscript><img alt></noscript>");
  });

  test("is part of the page normaliser", async () => {
    const normalize = createHtmlNormalizer(async (css) => css, () => false);
    expect(await normalize('<pre data-seen="" title="&#34;">x</pre>')).toBe(await normalize('<pre data-seen title="&quot;">x</pre>'));
  });
});
