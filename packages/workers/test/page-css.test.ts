import { describe, expect, test } from "bun:test";
import type { ModuleId } from "@pletivo/core/artifact";
import type { ResolvedStyleGraph } from "../src/compiled-program.ts";
import { finalizeHtml, moduleOrder, pageCss } from "../src/page-css.ts";

/** A pletivo-native project's page. */
const NATIVE = { compressHTML: undefined, partial: false };
const PAGE = "project:page.astro";
const LAYOUT = "npm:layout/Layout.astro";
const HEADER = "npm:layout/Header.astro";

function graph(
  modules: ModuleId[],
  executionEdges: ResolvedStyleGraph["executionEdges"] = [],
  styles: ResolvedStyleGraph["styles"] = [],
): ResolvedStyleGraph {
  return { modules, executionEdges, styleEdges: [], styles, tailwindModules: [] };
}

describe("moduleOrder", () => {
  test("uses logical ModuleIds and source edge order", () => {
    const styleGraph = graph(
      [PAGE, LAYOUT, HEADER],
      [
        { importer: PAGE, target: LAYOUT },
        { importer: LAYOUT, target: HEADER },
      ],
    );
    expect(moduleOrder(PAGE, styleGraph)).toEqual([HEADER, LAYOUT, PAGE]);
  });

  test("deduplicates a shared module and survives cycles", () => {
    const shared = "npm:shared/index.js";
    const right = "project:right.js";
    const styleGraph = graph(
      [PAGE, LAYOUT, right, shared],
      [
        { importer: PAGE, target: LAYOUT },
        { importer: PAGE, target: right },
        { importer: LAYOUT, target: shared },
        { importer: right, target: shared },
        { importer: shared, target: PAGE },
      ],
    );
    expect(moduleOrder(PAGE, styleGraph)).toEqual([shared, LAYOUT, right, PAGE]);
  });
});

const styleGraph = graph(
  [PAGE, LAYOUT, HEADER, "project:Unused.astro"],
  [
    { importer: PAGE, target: LAYOUT },
    { importer: LAYOUT, target: HEADER },
  ],
  [
    { moduleId: LAYOUT, scope: "aaa", blocks: [{ global: false, css: "L{}" }] },
    { moduleId: HEADER, scope: "bbb", blocks: [{ global: true, css: "H{}" }] },
    { moduleId: "project:Unused.astro", scope: "ccc", blocks: [{ global: false, css: "U{}" }] },
    { moduleId: PAGE, scope: "ddd", blocks: [{ global: false, css: "P{}" }] },
  ],
);

describe("pageCss", () => {
  test("emits artifact and project contributors in canonical cascade order", () => {
    expect(pageCss({
      entry: PAGE,
      graph: styleGraph,
      html: '<div class="astro-aaa astro-ddd">x</div>',
      renderedModules: new Set([PAGE, LAYOUT, HEADER]),
    })).toBe("H{}\nL{}\nP{}");
  });

  test("keeps scoped and global visibility gates distinct", () => {
    expect(pageCss({
      entry: PAGE,
      graph: styleGraph,
      html: '<div class="astro-ddd">x</div>',
      renderedModules: new Set([PAGE, HEADER, "project:Unused.astro"]),
    })).toBe("H{}\nP{}");
  });
});

describe("pageCss under the attribute strategy", () => {
  test("a data-astro-cid attribute shows the component, as a scope class does", () => {
    expect(pageCss({
      entry: PAGE,
      graph: styleGraph,
      html: '<div data-astro-cid-aaa>x</div><p data-astro-cid-ddd>y</p>',
      renderedModules: new Set([PAGE, LAYOUT]),
    })).toBe("L{}\nP{}");
  });
});

describe("finalizeHtml", () => {
  test("keeps CSS and injected-script ordering", () => {
    expect(finalizeHtml(
      "<html><head></head><body>x</body></html>",
      NATIVE,
      ["site{}", "scoped{}"],
      { headInline: ["headOne()", "headTwo()"], page: ["pageOne()"] },
    )).toBe(
      '<!DOCTYPE html>\n<html><head><style>site{}</style>\n<style>scoped{}</style>\n' +
      '<script>headOne()</script>\n<script>headTwo()</script>\n' +
      '<script type="module">pageOne()</script>\n</head><body>x</body></html>',
    );
  });

  test("escapes every case-insensitive literal style end sequence", () => {
    const html = finalizeHtml(
      "<html><head></head><body><p>safe</p></body></html>",
      NATIVE,
      ['a::after{content:"</StYlE><script>bad()</script>"}'],
    );
    expect(html.match(/<style>/g)).toHaveLength(1);
    expect(html.match(/<\/style>/gi)).toHaveLength(1);
    expect(html).not.toContain("</StYlE><script>");
    expect(html).toContain("<\\/StYlE><script>");
  });

  test("inserts CSS and scripts verbatim, `$` replacement patterns included", () => {
    const dollars = "$$|$&|$'|$`";
    for (const html of ["<html><head></head><body>x</body></html>", "<html><body>x</body></html>"]) {
      const out = finalizeHtml(html, NATIVE, [`a::after{content:"${dollars}"}`], {
        headInline: [`head("${dollars}")`],
        page: [`page("${dollars}")`],
      });
      expect(out).toContain(`content:"${dollars}"`);
      if (html.includes("</head>")) {
        expect(out).toContain(`<script>head("${dollars}")</script>`);
        expect(out).toContain(`<script type="module">page("${dollars}")</script>`);
      }
    }
  });

  test("falls back to body then front without reversing CSS", () => {
    const ordered = "<style>site{}</style>\n<style>scoped{}</style>";
    expect(finalizeHtml("<html><body>x</body></html>", NATIVE, ["site{}", "scoped{}"]))
      .toBe(`<!DOCTYPE html>\n<html><body>x${ordered}\n</body></html>`);
    expect(finalizeHtml("<p>x</p>", NATIVE, ["site{}", "scoped{}"]))
      .toBe(`${ordered}\n<p>x</p>`);
  });

  test("puts an Astro project's doctype before CSS prepended to a page without <head>", () => {
    expect(finalizeHtml("<p>x</p>", { compressHTML: true, partial: false }, ["site{}"]))
      .toBe("<!DOCTYPE html><style>site{}</style>\n<p>x</p>");
    expect(finalizeHtml("<p>x</p>", { compressHTML: false, partial: false }, ["site{}"]))
      .toBe("<!DOCTYPE html>\n<style>site{}</style>\n<p>x</p>");
    expect(finalizeHtml("<p>x</p>", { compressHTML: true, partial: true }, ["site{}"]))
      .toBe("<style>site{}</style>\n<p>x</p>");
  });

  test("merges an Astro project's stylesheet and scoped CSS into one <style>, as the build inlines them", () => {
    for (const compressHTML of [true, false]) {
      expect(finalizeHtml(
        "<html><head></head><body>x</body></html>",
        { compressHTML, partial: false },
        ["site{}", "", "scoped{}"],
      )).toContain("<head><style>site{}\nscoped{}</style>\n</head>");
    }
    expect(finalizeHtml("<html><head></head><body>x</body></html>", { compressHTML: true, partial: false }, ["", ""]))
      .not.toContain("<style>");
  });
});
