import { describe, expect, test } from "bun:test";
import type { AstroStyles } from "../src/compile-project.ts";
import { extractAstroClasses, finalizeHtml, moduleOrder, pageCss } from "../src/page-css.ts";

/**
 * The cases `tests/conformance/fixtures/css-cascade-order` pins for the Bun host,
 * asserted directly against the ordering this host uses.
 */
describe("moduleOrder", () => {
  test("puts a component before the module importing it, page last", () => {
    const imports = new Map([
      ["page.astro", ["Layout.astro"]],
      ["Layout.astro", ["Header.astro"]],
    ]);
    expect(moduleOrder("page.astro", imports)).toEqual([
      "Header.astro",
      "Layout.astro",
      "page.astro",
    ]);
  });

  test("follows import order, not render order", () => {
    const imports = new Map([["page.astro", ["Second.astro", "First.astro"]]]);
    expect(moduleOrder("page.astro", imports)).toEqual([
      "Second.astro",
      "First.astro",
      "page.astro",
    ]);
  });

  test("keeps a module reached twice in its first position", () => {
    const imports = new Map([
      ["page.astro", ["A.astro", "B.astro"]],
      ["A.astro", ["Shared.astro"]],
      ["B.astro", ["Shared.astro"]],
    ]);
    expect(moduleOrder("page.astro", imports)).toEqual([
      "Shared.astro",
      "A.astro",
      "B.astro",
      "page.astro",
    ]);
  });

  test("survives an import cycle", () => {
    const imports = new Map([
      ["a.astro", ["b.astro"]],
      ["b.astro", ["a.astro"]],
    ]);
    expect(moduleOrder("a.astro", imports)).toEqual(["b.astro", "a.astro"]);
  });
});

const styles = new Map<string, AstroStyles>([
  ["Layout.astro", { scope: "aaa", blocks: [{ global: false, css: "L{}" }] }],
  ["Header.astro", { scope: "bbb", blocks: [{ global: true, css: "H{}" }] }],
  ["Unused.astro", { scope: "ccc", blocks: [{ global: false, css: "U{}" }] }],
  ["page.astro", { scope: "ddd", blocks: [{ global: false, css: "P{}" }] }],
]);
const imports = new Map([
  ["page.astro", ["Layout.astro"]],
  ["Layout.astro", ["Header.astro"]],
]);

describe("pageCss", () => {
  test("emits the page's contributors in cascade order", () => {
    expect(
      pageCss({
        entry: "page.astro",
        styles,
        imports,
        html: '<div class="astro-aaa astro-ddd">x</div>',
        renderedModules: new Set(["page.astro", "Layout.astro", "Header.astro"]),
      }),
    ).toBe("H{}\nL{}\nP{}");
  });

  test("gates a scoped block on its class, not on the component rendering", () => {
    // Unused.astro rendered but emitted no scoped DOM: its scoped block stays out.
    expect(
      pageCss({
        entry: "page.astro",
        styles,
        imports,
        html: '<div class="astro-ddd">x</div>',
        renderedModules: new Set(["page.astro", "Unused.astro"]),
      }),
    ).toBe("P{}");
  });

  test("gates an is:global block on the component rendering, not on a class", () => {
    // Header.astro has no scope class in the HTML — only the render pass can see it.
    expect(
      pageCss({
        entry: "page.astro",
        styles,
        imports,
        html: "<div>x</div>",
        renderedModules: new Set(["Header.astro"]),
      }),
    ).toBe("H{}");
  });

  test("is empty when nothing contributes", () => {
    expect(
      pageCss({ entry: "page.astro", styles, imports, html: "<p>x</p>", renderedModules: new Set() }),
    ).toBe("");
  });
});

describe("extractAstroClasses", () => {
  test("finds every scope class in the HTML", () => {
    expect([...extractAstroClasses('<p class="card astro-a1b2 astro-c3d4">x</p>')].sort()).toEqual([
      "astro-a1b2",
      "astro-c3d4",
    ]);
  });
});

describe("finalizeHtml", () => {
  test("adds a doctype when the template starts at <html>", () => {
    expect(finalizeHtml("<html><body>x</body></html>", [])).toBe(
      "<!DOCTYPE html>\n<html><body>x</body></html>",
    );
  });

  test("leaves a doctype the template already wrote", () => {
    const html = "<!doctype html>\n<html><body>x</body></html>";
    expect(finalizeHtml(html, [])).toBe(html);
  });

  test("adds nothing to a fragment", () => {
    expect(finalizeHtml("<p>x</p>", [])).toBe("<p>x</p>");
  });

  test("puts the CSS in the head", () => {
    expect(finalizeHtml("<html><head></head><body>x</body></html>", ["a{}"])).toBe(
      "<!DOCTYPE html>\n<html><head><style>a{}</style>\n</head><body>x</body></html>",
    );
  });

  test("falls back to the body, then to the front, when there is no head", () => {
    expect(finalizeHtml("<html><body>x</body></html>", ["a{}"])).toBe(
      "<!DOCTYPE html>\n<html><body>x<style>a{}</style>\n</body></html>",
    );
    expect(finalizeHtml("<p>x</p>", ["a{}"])).toBe("<style>a{}</style>\n<p>x</p>");
  });

  test("keeps the parts in order down every branch, including the prepend", () => {
    // The reason the parts arrive as a list: two separate insertions before the same
    // anchor come out in the order they were made in `<head>`, and in the *reverse*
    // order when there is no head and each one prepends.
    const ordered = "<style>site{}</style>\n<style>scoped{}</style>";
    expect(finalizeHtml("<html><head></head><body>x</body></html>", ["site{}", "scoped{}"])).toBe(
      `<!DOCTYPE html>\n<html><head>${ordered}\n</head><body>x</body></html>`,
    );
    expect(finalizeHtml("<html><body>x</body></html>", ["site{}", "scoped{}"])).toBe(
      `<!DOCTYPE html>\n<html><body>x${ordered}\n</body></html>`,
    );
    expect(finalizeHtml("<p>x</p>", ["site{}", "scoped{}"])).toBe(`${ordered}\n<p>x</p>`);
  });

  test("skips an empty part rather than emitting an empty <style>", () => {
    expect(finalizeHtml("<html><head></head><body>x</body></html>", ["", "a{}"])).toBe(
      "<!DOCTYPE html>\n<html><head><style>a{}</style>\n</head><body>x</body></html>",
    );
  });
});
