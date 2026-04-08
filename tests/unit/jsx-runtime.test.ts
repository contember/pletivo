import { describe, test, expect, beforeEach } from "bun:test";
import { jsx, jsxs, jsxDEV, Fragment, type HtmlString } from "../../src/runtime/jsx-runtime";
import { resetIslandRegistry, getUsedIslands } from "../../src/runtime/island";

function html(result: HtmlString | Promise<HtmlString>): string {
  if (result instanceof Promise) throw new Error("Unexpected promise");
  return result.__html;
}

describe("HTML elements", () => {
  test("renders div with text", () => {
    expect(html(jsx("div", { children: "Hello" }))).toBe("<div>Hello</div>");
  });

  test("renders void element (br)", () => {
    expect(html(jsx("br", {}))).toBe("<br>");
  });

  test("renders void element (img) with attributes", () => {
    expect(html(jsx("img", { src: "/logo.png", alt: "Logo" }))).toBe(
      '<img src="/logo.png" alt="Logo">',
    );
  });

  test("renders attributes", () => {
    expect(html(jsx("a", { href: "/about", children: "About" }))).toBe(
      '<a href="/about">About</a>',
    );
  });

  test("className becomes class", () => {
    expect(html(jsx("div", { className: "foo", children: "x" }))).toBe(
      '<div class="foo">x</div>',
    );
  });

  test("htmlFor becomes for", () => {
    expect(html(jsx("label", { htmlFor: "name", children: "Name" }))).toBe(
      '<label for="name">Name</label>',
    );
  });

  test("boolean attribute true renders as flag", () => {
    expect(html(jsx("input", { disabled: true }))).toBe("<input disabled>");
  });

  test("boolean attribute false is omitted", () => {
    expect(html(jsx("input", { disabled: false }))).toBe("<input>");
  });

  test("null/undefined attributes are omitted", () => {
    expect(html(jsx("div", { id: null, children: "x" }))).toBe("<div>x</div>");
    expect(html(jsx("div", { id: undefined, children: "x" }))).toBe("<div>x</div>");
  });

  test("key and ref are omitted", () => {
    expect(html(jsx("div", { key: "1", ref: "r", children: "x" }))).toBe("<div>x</div>");
  });
});

describe("children rendering", () => {
  test("string children are escaped", () => {
    expect(html(jsx("div", { children: "<script>alert(1)</script>" }))).toBe(
      "<div>&lt;script&gt;alert(1)&lt;/script&gt;</div>",
    );
  });

  test("number children", () => {
    expect(html(jsx("span", { children: 42 }))).toBe("<span>42</span>");
  });

  test("null/false/true children render nothing", () => {
    expect(html(jsx("div", { children: null }))).toBe("<div></div>");
    expect(html(jsx("div", { children: false }))).toBe("<div></div>");
    expect(html(jsx("div", { children: true }))).toBe("<div></div>");
  });

  test("array children", () => {
    const children = [
      jsx("li", { children: "a" }),
      jsx("li", { children: "b" }),
    ];
    expect(html(jsx("ul", { children }))).toBe("<ul><li>a</li><li>b</li></ul>");
  });

  test("nested HtmlString children", () => {
    const inner = jsx("span", { children: "inner" });
    expect(html(jsx("div", { children: inner }))).toBe("<div><span>inner</span></div>");
  });

  test("mixed children in array", () => {
    const children = ["Hello ", jsx("strong", { children: "world" })];
    expect(html(jsx("p", { children }))).toBe("<p>Hello <strong>world</strong></p>");
  });
});

describe("escaping", () => {
  test("escapes text content", () => {
    expect(html(jsx("div", { children: 'a & b < c > d "e"' }))).toBe(
      "<div>a &amp; b &lt; c &gt; d &quot;e&quot;</div>",
    );
  });

  test("escapes attribute values", () => {
    expect(html(jsx("div", { title: 'a & "b"', children: "x" }))).toBe(
      '<div title="a &amp; &quot;b&quot;">x</div>',
    );
  });
});

describe("dangerouslySetInnerHTML", () => {
  test("injects raw HTML", () => {
    expect(
      html(jsx("div", { dangerouslySetInnerHTML: { __html: "<b>raw</b>" } })),
    ).toBe("<div><b>raw</b></div>");
  });
});

describe("Fragment", () => {
  test("renders only children", () => {
    const result = Fragment({ children: [jsx("span", { children: "a" }), jsx("span", { children: "b" })] });
    expect(result.__html).toBe("<span>a</span><span>b</span>");
  });

  test("renders text children", () => {
    expect(Fragment({ children: "hello" }).__html).toBe("hello");
  });

  test("renders empty", () => {
    expect(Fragment({  }).__html).toBe("");
  });
});

describe("function components", () => {
  test("simple component", () => {
    function Greeting(props: { name: string }) {
      return jsx("h1", { children: `Hello ${props.name}` });
    }
    expect(html(jsx(Greeting, { name: "World" }))).toBe("<h1>Hello World</h1>");
  });

  test("nested components", () => {
    function Inner(props: { children?: unknown }) {
      return jsx("span", { children: props.children });
    }
    function Outer() {
      return jsx("div", { children: jsx(Inner, { children: "nested" }) });
    }
    expect(html(jsx(Outer, {}))).toBe("<div><span>nested</span></div>");
  });
});

describe("async components", () => {
  test("resolves async component", async () => {
    async function AsyncComp() {
      return jsx("div", { children: "async" });
    }
    const result = jsx(AsyncComp, {});
    expect(result).toBeInstanceOf(Promise);
    expect(html(await result)).toBe("<div>async</div>");
  });
});

describe("island detection", () => {
  beforeEach(() => {
    resetIslandRegistry();
  });

  test("client prop triggers island wrapper", () => {
    function MyIsland(props: { count: number }) {
      return jsx("button", { children: String(props.count) });
    }
    const result = jsx(MyIsland, { client: "load", count: 5, __islandName: "MyIsland" });
    const h = html(result);
    expect(h).toContain("<pavouk-island");
    expect(h).toContain('data-component="MyIsland"');
    expect(h).toContain('data-hydrate="load"');
    expect(h).toContain("<button>5</button>");
  });

  test("island registers in registry", () => {
    function TestIsland() {
      return jsx("div", { children: "test" });
    }
    jsx(TestIsland, { client: "visible", __islandName: "TestIsland" });
    const islands = getUsedIslands();
    expect(islands.has("TestIsland")).toBe(true);
  });

  test("island props are serialized (without internal props)", () => {
    function Counter(props: { initial: number }) {
      return jsx("span", { children: String(props.initial) });
    }
    const h = html(jsx(Counter, { client: "idle", initial: 10, __islandName: "Counter" }));
    expect(h).toContain('"initial":10');
    expect(h).not.toContain("__islandName");
    expect(h).not.toContain('"client"');
  });

  test("different hydration strategies", () => {
    function W(props: { x?: number }) {
      return jsx("div", { children: "w" });
    }

    expect(html(jsx(W, { client: "load", __islandName: "W" }))).toContain('data-hydrate="load"');

    resetIslandRegistry();
    expect(html(jsx(W, { client: "idle", __islandName: "W" }))).toContain('data-hydrate="idle"');

    resetIslandRegistry();
    expect(html(jsx(W, { client: "visible", __islandName: "W" }))).toContain('data-hydrate="visible"');

    resetIslandRegistry();
    expect(html(jsx(W, { client: "media(max-width: 768px)", __islandName: "W" }))).toContain('data-hydrate="media(max-width: 768px)"');
  });
});

describe("jsxs and jsxDEV aliases", () => {
  test("jsxs is same as jsx", () => {
    expect(jsxs).toBe(jsx);
  });

  test("jsxDEV is same as jsx", () => {
    expect(jsxDEV).toBe(jsx);
  });
});
