import { describe, expect, test } from "bun:test";
import type { ModuleId } from "@pletivo/core/artifact";
import type { ResolvedStyleGraph } from "../src/compiled-program.ts";
import { extractAstroClasses, finalizeHtml, moduleOrder, pageCss } from "../src/page-css.ts";

const PAGE = "project:page.astro";
const LAYOUT = "npm:layout/Layout.astro";
const HEADER = "npm:layout/Header.astro";

function graph(
  modules: ModuleId[],
  executionEdges: ResolvedStyleGraph["executionEdges"] = [],
  styles: ResolvedStyleGraph["styles"] = [],
): ResolvedStyleGraph {
  return { modules, executionEdges, styleEdges: [], styles };
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

describe("extractAstroClasses", () => {
  test("finds every scope class in the HTML", () => {
    expect([...extractAstroClasses('<p class="card astro-a1b2 astro-c3d4">x</p>')].sort()).toEqual([
      "astro-a1b2",
      "astro-c3d4",
    ]);
  });
});

describe("finalizeHtml", () => {
  test("keeps CSS and injected-script ordering", () => {
    expect(finalizeHtml(
      "<html><head></head><body>x</body></html>",
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
      ['a::after{content:"</StYlE><script>bad()</script>"}'],
    );
    expect(html.match(/<style>/g)).toHaveLength(1);
    expect(html.match(/<\/style>/gi)).toHaveLength(1);
    expect(html).not.toContain("</StYlE><script>");
    expect(html).toContain("\\3C /style><script>");
  });

  test("falls back to body then front without reversing CSS", () => {
    const ordered = "<style>site{}</style>\n<style>scoped{}</style>";
    expect(finalizeHtml("<html><body>x</body></html>", ["site{}", "scoped{}"]))
      .toBe(`<!DOCTYPE html>\n<html><body>x${ordered}\n</body></html>`);
    expect(finalizeHtml("<p>x</p>", ["site{}", "scoped{}"]))
      .toBe(`${ordered}\n<p>x</p>`);
  });
});
