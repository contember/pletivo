import { describe, test, expect } from "bun:test";
import { parseMarkdown } from "../../packages/pavouk/src/content/markdown";

describe("frontmatter parsing", () => {
  test("extracts key-value pairs", () => {
    const result = parseMarkdown(`---
title: Hello World
---

Content`);
    expect(result.frontmatter.title).toBe("Hello World");
    expect(result.body.trim()).toBe("Content");
  });

  test("handles quoted strings", () => {
    const result = parseMarkdown(`---
title: "Hello: World"
---

x`);
    expect(result.frontmatter.title).toBe("Hello: World");
  });

  test("parses booleans", () => {
    const result = parseMarkdown(`---
draft: true
published: false
---

x`);
    expect(result.frontmatter.draft).toBe(true);
    expect(result.frontmatter.published).toBe(false);
  });

  test("parses numbers", () => {
    const result = parseMarkdown(`---
order: 42
rating: 3.5
---

x`);
    expect(result.frontmatter.order).toBe(42);
    expect(result.frontmatter.rating).toBe(3.5);
  });

  test("parses inline arrays", () => {
    const result = parseMarkdown(`---
tags: [foo, bar, baz]
---

x`);
    expect(result.frontmatter.tags).toEqual(["foo", "bar", "baz"]);
  });

  test("parses multiline arrays", () => {
    const result = parseMarkdown(`---
tags:
- foo
- bar
---

x`);
    expect(result.frontmatter.tags).toEqual(["foo", "bar"]);
  });

  test("missing frontmatter returns empty object", () => {
    const result = parseMarkdown("Just content");
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe("Just content");
  });
});

describe("block elements", () => {
  test("headings h1-h6", () => {
    const result = parseMarkdown("---\n---\n\n# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6");
    expect(result.html).toContain("<h1>H1</h1>");
    expect(result.html).toContain("<h2>H2</h2>");
    expect(result.html).toContain("<h3>H3</h3>");
    expect(result.html).toContain("<h4>H4</h4>");
    expect(result.html).toContain("<h5>H5</h5>");
    expect(result.html).toContain("<h6>H6</h6>");
  });

  test("paragraphs", () => {
    const result = parseMarkdown("---\n---\n\nFirst paragraph.\n\nSecond paragraph.");
    expect(result.html).toContain("<p>First paragraph.</p>");
    expect(result.html).toContain("<p>Second paragraph.</p>");
  });

  test("fenced code block", () => {
    const result = parseMarkdown("---\n---\n\n```js\nconst x = 1;\n```");
    expect(result.html).toContain('<pre><code class="language-js">const x = 1;</code></pre>');
  });

  test("code block without language", () => {
    const result = parseMarkdown("---\n---\n\n```\nhello\n```");
    expect(result.html).toContain("<pre><code>hello</code></pre>");
  });

  test("code block escapes HTML", () => {
    const result = parseMarkdown("---\n---\n\n```\n<div>test</div>\n```");
    expect(result.html).toContain("&lt;div&gt;test&lt;/div&gt;");
  });

  test("blockquote", () => {
    const result = parseMarkdown("---\n---\n\n> This is a quote.");
    expect(result.html).toContain("<blockquote><p>This is a quote.</p></blockquote>");
  });

  test("unordered list", () => {
    const result = parseMarkdown("---\n---\n\n- Item 1\n- Item 2\n- Item 3");
    expect(result.html).toContain("<ul>");
    expect(result.html).toContain("<li>Item 1</li>");
    expect(result.html).toContain("<li>Item 2</li>");
    expect(result.html).toContain("<li>Item 3</li>");
    expect(result.html).toContain("</ul>");
  });

  test("ordered list", () => {
    const result = parseMarkdown("---\n---\n\n1. First\n2. Second");
    expect(result.html).toContain("<ol>");
    expect(result.html).toContain("<li>First</li>");
    expect(result.html).toContain("<li>Second</li>");
    expect(result.html).toContain("</ol>");
  });

  test("horizontal rule", () => {
    const result = parseMarkdown("---\n---\n\n---");
    expect(result.html).toContain("<hr>");
  });

  test("horizontal rule with asterisks", () => {
    const result = parseMarkdown("---\n---\n\n***");
    expect(result.html).toContain("<hr>");
  });
});

describe("inline elements", () => {
  test("bold with asterisks", () => {
    const result = parseMarkdown("---\n---\n\nThis is **bold** text.");
    expect(result.html).toContain("This is <strong>bold</strong> text.");
  });

  test("bold with underscores", () => {
    const result = parseMarkdown("---\n---\n\nThis is __bold__ text.");
    expect(result.html).toContain("This is <strong>bold</strong> text.");
  });

  test("italic with asterisks", () => {
    const result = parseMarkdown("---\n---\n\nThis is *italic* text.");
    expect(result.html).toContain("This is <em>italic</em> text.");
  });

  test("bold and italic", () => {
    const result = parseMarkdown("---\n---\n\n***both***");
    expect(result.html).toContain("<strong><em>both</em></strong>");
  });

  test("inline code", () => {
    const result = parseMarkdown("---\n---\n\nUse `const x = 1` here.");
    expect(result.html).toContain("Use <code>const x = 1</code> here.");
  });

  test("inline code escapes HTML", () => {
    const result = parseMarkdown("---\n---\n\nUse `<div>` tag.");
    expect(result.html).toContain("<code>&lt;div&gt;</code>");
  });

  test("link", () => {
    const result = parseMarkdown("---\n---\n\nVisit [example](https://example.com).");
    expect(result.html).toContain('<a href="https://example.com">example</a>');
  });

  test("image", () => {
    const result = parseMarkdown("---\n---\n\n![Alt text](/img.png)");
    expect(result.html).toContain('<img src="/img.png" alt="Alt text">');
  });
});

describe("edge cases", () => {
  test("empty input", () => {
    const result = parseMarkdown("");
    expect(result.frontmatter).toEqual({});
    expect(result.html).toBe("");
  });

  test("only frontmatter", () => {
    const result = parseMarkdown("---\ntitle: Test\n---\n");
    expect(result.frontmatter.title).toBe("Test");
    expect(result.html).toBe("");
  });

  test("raw HTML in markdown passes through (standard behavior)", () => {
    const result = parseMarkdown("---\ntitle: test\n---\n\n<div class=\"custom\">hello</div>");
    expect(result.html).toContain('<div class="custom">hello</div>');
  });

  test("consecutive paragraphs with inline formatting", () => {
    const result = parseMarkdown("---\n---\n\nHello **world**.\n\nFoo *bar*.");
    expect(result.html).toContain("<p>Hello <strong>world</strong>.</p>");
    expect(result.html).toContain("<p>Foo <em>bar</em>.</p>");
  });
});
