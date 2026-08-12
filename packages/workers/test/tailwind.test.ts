import { describe, expect, test } from "bun:test";
import { compileTailwind, extractCandidates, scanCandidates } from "../src/tailwind.ts";
import { tailwindDir, tailwindStylesheets } from "./tailwind-sources.ts";

/** `tailwindcss` is an optional peer: skip the engine tests where it is not installed. */
const TAILWIND_DIR = tailwindDir();

describe("extractCandidates", () => {
  test("pulls class names out of markup", () => {
    const found = new Set(extractCandidates('<div class="mx-auto max-w-3xl sm:px-6"></div>'));
    expect(found).toContain("mx-auto");
    expect(found).toContain("max-w-3xl");
    expect(found).toContain("sm:px-6");
  });

  test("keeps arbitrary values whole", () => {
    const found = new Set(
      extractCandidates('<p class="text-[13px] grid-cols-[1fr_2fr] data-[state=open]:underline"></p>'),
    );
    expect(found).toContain("text-[13px]");
    expect(found).toContain("grid-cols-[1fr_2fr]");
    expect(found).toContain("data-[state=open]:underline");
  });

  test("looks inside quote and bracket groups", () => {
    const found = new Set(extractCandidates(`classList.add('line-through', "italic")`));
    expect(found).toContain("line-through");
    expect(found).toContain("italic");
  });

  test("keeps the fractional utilities apart from prose", () => {
    const found = new Set(extractCandidates('<div class="p-0.5 mt-1.5 sm:px-6">'));
    expect(found).toContain("p-0.5");
    expect(found).toContain("mt-1.5");
    expect(found).toContain("sm:px-6");
  });

  test("stops a span at a character that cannot sit inside a candidate", () => {
    // `underline` is dropped, not trimmed: what follows it is not a valid boundary.
    expect(new Set(extractCandidates("the underline, and italic"))).toEqual(
      new Set(["the", "and", "italic"]),
    );
  });

  test("still reads inside a bracket group too long to be a candidate", () => {
    // A `[` with a distant `]` used to swallow everything between them into one span,
    // and then re-scan from every quote and bracket inside it. On the static dogfood site's 626 kB
    // `asset-manifest.json` that took 449 seconds for the one file.
    const source = `[${", ".repeat(4000)}"mt-4" "text-sm"]`;
    const started = Bun.nanoseconds();
    const found = new Set(extractCandidates(source));
    expect((Bun.nanoseconds() - started) / 1e6).toBeLessThan(500);
    expect(found).toContain("mt-4");
    expect(found).toContain("text-sm");
    // …and the 8 kB span itself is not offered as a utility.
    for (const candidate of found) expect(candidate.length).toBeLessThan(2048);
  });

  test("keeps a long arbitrary value that really is a candidate", () => {
    const value = `bg-[url('data:image/svg+xml;base64,${"A".repeat(1000)}')]`;
    expect(new Set(extractCandidates(`<div class="${value}">`))).toContain(value);
  });
});

describe("scanCandidates", () => {
  test("reads the virtual file map and skips stylesheets", () => {
    const found = new Set(
      scanCandidates(
        new Map([
          ["src/pages/index.astro", '<h1 class="from-markup">x</h1>'],
          ["src/styles/global.css", ".from-css { color: red }"],
        ]),
      ),
    );
    expect(found).toContain("from-markup");
    expect(found).not.toContain("from-css");
  });
});

describe.skipIf(TAILWIND_DIR === null)("compileTailwind", () => {
  test("builds only the utilities the virtual sources use", async () => {
    const files = new Map([
      ["src/styles/global.css", '@import "tailwindcss";\n@import "./tokens.css";'],
      ["src/styles/tokens.css", "@theme { --spacing-huge: 12rem; }"],
      ["src/pages/index.astro", '<h1 class="mt-4 text-red-500 p-huge">hi</h1>'],
    ]);
    const css = await compileTailwind({
      entry: "src/styles/global.css",
      files,
      stylesheets: await tailwindStylesheets(),
    });

    expect(css).toContain(".mt-4");
    expect(css).toContain(".text-red-500");
    // Relative @import resolved out of the map, and its theme value used.
    expect(css).toContain("--spacing-huge");
    expect(css).toContain(".p-huge");
    // Not in any source file, so not emitted.
    expect(css).not.toContain(".mt-96");
  });

  test("builds the candidates it was handed instead of scanning the files", async () => {
    // What the per-page model rides on: the content is the page that just rendered,
    // not the source tree. `files` is still where `@import` resolves.
    const files = new Map([
      ["src/styles/global.css", '@import "tailwindcss";'],
      ["src/pages/index.astro", '<h1 class="mt-4">hi</h1>'],
    ]);
    const css = await compileTailwind({
      entry: "src/styles/global.css",
      files,
      stylesheets: await tailwindStylesheets(),
      candidates: ["p-2"],
    });

    expect(css).toContain(".p-2");
    expect(css).not.toContain(".mt-4");
  });

  test("reports an @import it cannot resolve", async () => {
    const files = new Map([["src/styles/global.css", '@import "tailwindcss";\n@import "./gone.css";']]);
    await expect(
      compileTailwind({ entry: "src/styles/global.css", files, stylesheets: await tailwindStylesheets() }),
    ).rejects.toThrow(/cannot resolve stylesheet "\.\/gone\.css"/);
  });

  test("says JS plugins are unsupported rather than failing obscurely", async () => {
    const files = new Map([
      ["src/styles/global.css", '@import "tailwindcss";\n@plugin "./typography.js";'],
    ]);
    await expect(
      compileTailwind({ entry: "src/styles/global.css", files, stylesheets: await tailwindStylesheets() }),
    ).rejects.toThrow(/no module loader/);
  });

  test("rejects an entry that is not in the file map", async () => {
    await expect(
      compileTailwind({ entry: "missing.css", files: new Map(), stylesheets: await tailwindStylesheets() }),
    ).rejects.toThrow(/is not in the file map/);
  });
});
