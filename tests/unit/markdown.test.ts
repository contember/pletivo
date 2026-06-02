import { describe, test, expect } from "bun:test";
import { parseMarkdown } from "../../packages/pletivo/src/content/markdown";

// `parseMarkdown` runs the unified/remark pipeline (remark-parse → remark-gfm →
// remark-rehype → heading-id slugs → rehype-stringify) and is async. HTML is
// rehype-stringify output, so block elements carry remark's whitespace and `<`
// is escaped as `&#x3C;`.

describe("frontmatter parsing", () => {
  test("extracts key-value pairs", async () => {
    const result = await parseMarkdown(`---
title: Hello World
---

Content`);
    expect(result.frontmatter.title).toBe("Hello World");
    expect(result.body.trim()).toBe("Content");
  });

  test("handles quoted strings", async () => {
    const result = await parseMarkdown(`---
title: "Hello: World"
---

x`);
    expect(result.frontmatter.title).toBe("Hello: World");
  });

  test("parses booleans", async () => {
    const result = await parseMarkdown(`---
draft: true
published: false
---

x`);
    expect(result.frontmatter.draft).toBe(true);
    expect(result.frontmatter.published).toBe(false);
  });

  test("parses numbers", async () => {
    const result = await parseMarkdown(`---
order: 42
rating: 3.5
---

x`);
    expect(result.frontmatter.order).toBe(42);
    expect(result.frontmatter.rating).toBe(3.5);
  });

  test("parses inline arrays", async () => {
    const result = await parseMarkdown(`---
tags: [foo, bar, baz]
---

x`);
    expect(result.frontmatter.tags).toEqual(["foo", "bar", "baz"]);
  });

  test("parses multiline arrays", async () => {
    const result = await parseMarkdown(`---
tags:
- foo
- bar
---

x`);
    expect(result.frontmatter.tags).toEqual(["foo", "bar"]);
  });

  test("folded block scalar (>)", async () => {
    const result = await parseMarkdown(`---
excerpt: >
  First line
  second line
  third line.
---

Content`);
    expect(result.frontmatter.excerpt).toBe("First line second line third line.\n");
    expect(result.body.trim()).toBe("Content");
  });

  test("folded block scalar strip (>-)", async () => {
    const result = await parseMarkdown(`---
excerpt: >-
  First line
  second line
  third line.
---

Content`);
    expect(result.frontmatter.excerpt).toBe("First line second line third line.");
  });

  test("literal block scalar (|)", async () => {
    const result = await parseMarkdown(`---
bio: |
  Line one
  Line two
  Line three
---

Content`);
    expect(result.frontmatter.bio).toBe("Line one\nLine two\nLine three\n");
  });

  test("literal block scalar strip (|-)", async () => {
    const result = await parseMarkdown(`---
bio: |-
  Line one
  Line two
---

Content`);
    expect(result.frontmatter.bio).toBe("Line one\nLine two");
  });

  test("block scalar followed by another key", async () => {
    const result = await parseMarkdown(`---
excerpt: >
  Hello world
  foo bar.
title: Test
---

x`);
    expect(result.frontmatter.excerpt).toBe("Hello world foo bar.\n");
    expect(result.frontmatter.title).toBe("Test");
  });

  test("missing frontmatter returns empty object", async () => {
    const result = await parseMarkdown("Just content");
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe("Just content");
  });

  test("array of nested objects", async () => {
    const result = await parseMarkdown(`---
attachments:
  - file: foo.pdf
    title: Bar
  - file: baz.pdf
    title: Qux
---

x`);
    expect(result.frontmatter.attachments).toEqual([
      { file: "foo.pdf", title: "Bar" },
      { file: "baz.pdf", title: "Qux" },
    ]);
  });

  test("nested mapping", async () => {
    const result = await parseMarkdown(`---
author:
  name: Jane
  email: jane@example.com
---

x`);
    expect(result.frontmatter.author).toEqual({ name: "Jane", email: "jane@example.com" });
  });
});

describe("block elements", () => {
  test("headings h1-h6 with slug ids", async () => {
    const result = await parseMarkdown("---\ntitle: t\n---\n\n# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6");
    expect(result.html).toContain('<h1 id="h1">H1</h1>');
    expect(result.html).toContain('<h2 id="h2">H2</h2>');
    expect(result.html).toContain('<h3 id="h3">H3</h3>');
    expect(result.html).toContain('<h4 id="h4">H4</h4>');
    expect(result.html).toContain('<h5 id="h5">H5</h5>');
    expect(result.html).toContain('<h6 id="h6">H6</h6>');
  });

  test("paragraphs", async () => {
    const result = await parseMarkdown("---\ntitle: t\n---\n\nFirst paragraph.\n\nSecond paragraph.");
    expect(result.html).toContain("<p>First paragraph.</p>");
    expect(result.html).toContain("<p>Second paragraph.</p>");
  });

  test("fenced code block", async () => {
    const result = await parseMarkdown("---\ntitle: t\n---\n\n```js\nconst x = 1;\n```");
    expect(result.html).toContain('<pre><code class="language-js">const x = 1;\n</code></pre>');
  });

  test("code block without language", async () => {
    const result = await parseMarkdown("---\ntitle: t\n---\n\n```\nhello\n```");
    expect(result.html).toContain("<pre><code>hello\n</code></pre>");
  });

  test("code block escapes HTML", async () => {
    const result = await parseMarkdown("---\ntitle: t\n---\n\n```\n<div>test</div>\n```");
    expect(result.html).toContain("&#x3C;div>test&#x3C;/div>");
  });

  test("blockquote", async () => {
    const result = await parseMarkdown("---\ntitle: t\n---\n\n> This is a quote.");
    expect(result.html).toContain("<blockquote>\n<p>This is a quote.</p>\n</blockquote>");
  });

  test("unordered list", async () => {
    const result = await parseMarkdown("---\ntitle: t\n---\n\n- Item 1\n- Item 2\n- Item 3");
    expect(result.html).toContain("<ul>");
    expect(result.html).toContain("<li>Item 1</li>");
    expect(result.html).toContain("<li>Item 2</li>");
    expect(result.html).toContain("<li>Item 3</li>");
    expect(result.html).toContain("</ul>");
  });

  test("ordered list", async () => {
    const result = await parseMarkdown("---\ntitle: t\n---\n\n1. First\n2. Second");
    expect(result.html).toContain("<ol>");
    expect(result.html).toContain("<li>First</li>");
    expect(result.html).toContain("<li>Second</li>");
    expect(result.html).toContain("</ol>");
  });

  test("horizontal rule", async () => {
    const result = await parseMarkdown("---\ntitle: t\n---\n\ntext\n\n---\n\nmore");
    expect(result.html).toContain("<hr>");
  });

  test("gfm: strikethrough", async () => {
    const result = await parseMarkdown("---\ntitle: t\n---\n\n~~gone~~");
    expect(result.html).toContain("<del>gone</del>");
  });

  test("gfm: table", async () => {
    const result = await parseMarkdown("---\ntitle: t\n---\n\n| A | B |\n| - | - |\n| 1 | 2 |");
    expect(result.html).toContain("<table>");
    expect(result.html).toContain("<th>A</th>");
    expect(result.html).toContain("<td>1</td>");
  });
});

describe("inline elements", () => {
  test("bold with asterisks", async () => {
    const result = await parseMarkdown("---\ntitle: t\n---\n\nThis is **bold** text.");
    expect(result.html).toContain("This is <strong>bold</strong> text.");
  });

  test("bold with underscores", async () => {
    const result = await parseMarkdown("---\ntitle: t\n---\n\nThis is __bold__ text.");
    expect(result.html).toContain("This is <strong>bold</strong> text.");
  });

  test("italic with asterisks", async () => {
    const result = await parseMarkdown("---\ntitle: t\n---\n\nThis is *italic* text.");
    expect(result.html).toContain("This is <em>italic</em> text.");
  });

  test("bold and italic", async () => {
    const result = await parseMarkdown("---\ntitle: t\n---\n\n***both***");
    expect(result.html).toContain("<em><strong>both</strong></em>");
  });

  test("inline code", async () => {
    const result = await parseMarkdown("---\ntitle: t\n---\n\nUse `const x = 1` here.");
    expect(result.html).toContain("Use <code>const x = 1</code> here.");
  });

  test("inline code escapes HTML", async () => {
    const result = await parseMarkdown("---\ntitle: t\n---\n\nUse `<div>` tag.");
    expect(result.html).toContain("<code>&#x3C;div></code>");
  });

  test("link", async () => {
    const result = await parseMarkdown("---\ntitle: t\n---\n\nVisit [example](https://example.com).");
    expect(result.html).toContain('<a href="https://example.com">example</a>');
  });

  test("image", async () => {
    const result = await parseMarkdown("---\ntitle: t\n---\n\n![Alt text](/img.png)");
    expect(result.html).toContain('<img src="/img.png" alt="Alt text">');
  });
});

describe("edge cases", () => {
  test("empty input", async () => {
    const result = await parseMarkdown("");
    expect(result.frontmatter).toEqual({});
    expect(result.html).toBe("");
  });

  test("only frontmatter", async () => {
    const result = await parseMarkdown("---\ntitle: Test\n---\n");
    expect(result.frontmatter.title).toBe("Test");
    expect(result.html).toBe("");
  });

  test("raw HTML in markdown passes through (allowDangerousHtml)", async () => {
    const result = await parseMarkdown("---\ntitle: test\n---\n\n<div class=\"custom\">hello</div>");
    expect(result.html).toContain('<div class="custom">hello</div>');
  });

  test("consecutive paragraphs with inline formatting", async () => {
    const result = await parseMarkdown("---\ntitle: t\n---\n\nHello **world**.\n\nFoo *bar*.");
    expect(result.html).toContain("<p>Hello <strong>world</strong>.</p>");
    expect(result.html).toContain("<p>Foo <em>bar</em>.</p>");
  });

  // Regression: a line starting with `#` that is NOT a heading (no space after
  // the hashes) used to match no block branch while the paragraph collector
  // refused it, so the main loop never advanced and parsing hung forever.
  test("bare hashtag (no space) renders as paragraph, does not hang", async () => {
    const result = await parseMarkdown("#gohardsaturday");
    expect(result.html).toBe("<p>#gohardsaturday</p>");
  });

  test("hashtag line between paragraphs does not hang", async () => {
    const result = await parseMarkdown("First.\n\n#tag\n\nLast.");
    expect(result.html).toBe("<p>First.</p>\n<p>#tag</p>\n<p>Last.</p>");
  });

  test("hashtag line collected into a surrounding paragraph", async () => {
    const result = await parseMarkdown("before\n#tag\nafter");
    expect(result.html).toBe("<p>before\n#tag\nafter</p>");
  });

  test("more than six hashes is not a heading and does not hang", async () => {
    const result = await parseMarkdown("####### too many");
    expect(result.html).toBe("<p>####### too many</p>");
  });

  test("bare hash markers are empty headings (CommonMark), with no spurious id", async () => {
    // The old regex renderer emitted `<p>#</p>`; CommonMark treats a hash with
    // no content as an empty heading. rehypeHeadingIds adds no id (no text).
    const result = await parseMarkdown("#\n\n##");
    expect(result.html).toBe("<h1></h1>\n<h2></h2>");
  });

  test("real heading still interrupts a preceding paragraph", async () => {
    const result = await parseMarkdown("some text\n# Heading");
    expect(result.html).toBe('<p>some text</p>\n<h1 id="heading">Heading</h1>');
  });
});
