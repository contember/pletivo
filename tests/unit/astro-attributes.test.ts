import { describe, expect, test } from "bun:test";
import { addAttribute, defineStyleVars, spreadAttributes } from "../../packages/runtime/src/astro-shim";

const attr = (value: unknown, key: string, tagName?: string) => addAttribute(value, key, true, tagName).__html;

describe("addAttribute, as Astro renders attributes", () => {
  test("true and false are strings, except on a boolean attribute", () => {
    expect(attr(true, "data-open")).toBe(' data-open="true"');
    expect(attr(false, "data-open")).toBe(' data-open="false"');
    expect(attr(false, "aria-hidden")).toBe(' aria-hidden="false"');
    expect(attr(true, "disabled")).toBe(" disabled");
    expect(attr(false, "disabled")).toBe("");
    expect(attr("foo", "allowfullscreen")).toBe(" allowfullscreen");
    expect(attr("", "allowfullscreen")).toBe("");
    expect(attr(null, "disabled")).toBe("");
    expect(attr(undefined, "data-x")).toBe("");
  });

  test("a custom element gets a boolean attribute's value as a string", () => {
    expect(attr(false, "disabled", "my-element")).toBe(' disabled="false"');
    expect(spreadAttributes({ hidden: true }, "my-element").__html).toBe(' hidden="true"');
  });

  test("popover and download take a boolean, or a string", () => {
    expect(attr(true, "popover")).toBe(" popover");
    expect(attr(false, "download")).toBe("");
    expect(attr("manual", "popover")).toBe(' popover="manual"');
  });

  test("an empty string is a bare attribute", () => {
    expect(attr("", "data-empty")).toBe(" data-empty");
  });

  test("a style object becomes CSS text, a [object, string] pair is joined", () => {
    expect(attr({ backgroundColor: "blue", "--accent": "red", margin: 0, color: "", top: null }, "style")).toBe(
      ' style="background-color:blue;--accent:red;margin:0"',
    );
    expect(attr({ backgroundImage: 'url("a")' }, "style")).toBe(' style="background-image:url(&#34;a&#34;)"');
    expect(attr([{ color: "red" }, "top:0"], "style")).toBe(' style="color:red;top:0"');
    expect(attr("color: red", "style")).toBe(' style="color: red"');
    expect(attr(defineStyleVars({ fg: "black" }), "style")).toBe(' style="--fg: black;"');
  });

  test("className is class; class:list is joined", () => {
    expect(attr("a b", "className")).toBe(' class="a b"');
    expect(attr(["a", { b: true, c: false }, null], "class:list")).toBe(' class="a b"');
    expect(attr([false, null], "class:list")).toBe("");
  });

  test("escapes & and \" as Astro does, but keeps an http URL's query", () => {
    expect(attr('a & "b"', "title")).toBe(' title="a &#38; &#34;b&#34;"');
    expect(attr("https://example.com/?a=1&b=2", "href")).toBe(' href="https://example.com/?a=1&b=2"');
    expect(attr("/?a=1&b=2", "href")).toBe(' href="/?a=1&#38;b=2"');
  });

  test("set:html and set:text are not attributes", () => {
    expect(attr("<b>x</b>", "set:html")).toBe("");
  });
});
