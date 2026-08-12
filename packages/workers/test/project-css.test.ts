import { describe, expect, test } from "bun:test";
import {
  TailwindNotConfiguredError,
  pageStylesheet,
  tailwindEntry,
  type PageStylesheetOptions,
} from "../src/project-css.ts";
import { tailwindStylesheets, tailwindDir } from "./tailwind-sources.ts";

/** `pageStylesheet` inputs with the graph maps empty unless a test fills them. */
function options(
  files: Record<string, string>,
  overrides: Partial<PageStylesheetOptions> = {},
): PageStylesheetOptions {
  return {
    files: new Map(Object.entries(files)),
    srcDir: "src",
    rootDir: "",
    cssImports: new Map(),
    imports: new Map(),
    entry: "src/pages/index.astro",
    html: "",
    ...overrides,
  };
}

describe("pageStylesheet, the source tree", () => {
  test("is null when the project has no CSS at all", async () => {
    expect(await pageStylesheet(options({ "src/pages/index.astro": "<p>hi</p>" }))).toBeNull();
  });

  test("concatenates the source tree with a label per file, sorted by path", async () => {
    const css = await pageStylesheet(
      options({
        "src/styles/z.css": ".z { color: red }\n",
        "src/styles/a.css": ".a { color: blue }\n",
        "src/pages/index.astro": "<p>hi</p>",
      }),
    );
    expect(css).toBe(
      "/* styles/a.css */\n.a { color: blue }\n\n\n/* styles/z.css */\n.z { color: red }\n",
    );
  });

  test("carries a stylesheet no module imports, which is why it stays project-wide", async () => {
    // The common shape: `global.css` reaches the Bun host through its `**\/*.css` glob
    // and is never `import`ed from JavaScript. Narrowed to the page's graph it would
    // vanish, and the page would render unstyled with no error anywhere.
    const css = await pageStylesheet(options({ "src/styles/global.css": ".g {}\n" }));
    expect(css).toBe("/* styles/global.css */\n.g {}\n");
  });

  test("leaves CSS modules out — a different pipeline owns them, and it is not ported", async () => {
    expect(
      await pageStylesheet(options({ "src/components/Card.module.css": ".card {}" })),
    ).toBeNull();
  });

  test("takes only the source tree, not the whole file map", async () => {
    const css = await pageStylesheet(
      options({ "vendor/outside.css": ".v {}\n", "src/styles/in.css": ".i {}\n" }),
    );
    // `vendor/` reaches the page through an import, never through the glob.
    expect(css).toBe("/* styles/in.css */\n.i {}\n");
  });
});

describe("pageStylesheet — what the page's module graph imports", () => {
  const files = {
    "src/pages/index.astro": 'import "../styles/page.css";\nimport "../lib/util.js";\n',
    "src/lib/util.js": 'import "../styles/util.css";\nimport "../../vendor/util.css";\n',
    "src/styles/page.css": ".page {}\n",
    "src/styles/util.css": ".util {}\n",
    "vendor/util.css": ".vendor { color: rgb(1, 2, 3) }\n",
    // Only a Tailwind entry makes the host append the imported source CSS.
    "src/styles/global.css": '@import "tailwindcss";\n',
  };
  const graph = {
    cssImports: new Map([
      ["src/pages/index.astro", ["src/styles/page.css"]],
      ["src/lib/util.js", ["src/styles/util.css", "vendor/util.css"]],
    ]),
    imports: new Map([["src/pages/index.astro", ["src/lib/util.js"]]]),
    entry: "src/pages/index.astro",
  };

  test("walks transitively through JavaScript and frames out-of-tree CSS the way Bun.build does", async () => {
    const css = await pageStylesheet(
      options({ ...files, "src/styles/global.css": ".not-tailwind {}\n" }, graph),
    );
    // Not in Tailwind mode, so the source tree is already whole and only the
    // out-of-tree import is appended — with the file's own bytes, see the header.
    expect(css).toEndWith("/* vendor/util.css */\n.vendor { color: rgb(1, 2, 3) }\n");
    expect(css).toContain("/* styles/page.css */\n.page {}\n");
  });

  test("appends the imported source CSS in import-graph order once Tailwind owns the compile pass", async () => {
    if (tailwindDir() === null) return;
    const css = await pageStylesheet({ ...options(files, graph), tailwind: await tailwindStylesheets() });
    expect(css).toStartWith("/*! tailwindcss v4");
    // Both source stylesheets the graph named, labelled from the project root, after
    // the out-of-tree bundle — and `util.css` first, because `moduleOrder` puts the
    // module that imported it before the page. Sorting by path would have flipped them.
    expect(css).toEndWith(
      "/* src/styles/util.css */\n.util {}\n\n\n/* src/styles/page.css */\n.page {}\n",
    );
    // Never the one nothing imported.
    expect(css).not.toContain("/* src/styles/global.css */");
  });

  test("follows an .astro child, whose CSS used to be collected under a root of its own", async () => {
    // While every `.astro` file was its own collection root the walk had to skip them.
    // With one root per page, skipping meant a layout took its `import "./fonts.css"`
    // with it — on a real site, most of the CSS.
    const css = await pageStylesheet(
      options(
        {
          "src/pages/index.astro": 'import "../components/Layout.astro";\n',
          "src/components/Layout.astro": 'import "../../vendor/fonts.css";\n',
          "vendor/fonts.css": "@font-face { font-family: X }\n",
        },
        {
          imports: new Map([["src/pages/index.astro", ["src/components/Layout.astro"]]]),
          cssImports: new Map([["src/components/Layout.astro", ["vendor/fonts.css"]]]),
        },
      ),
    );
    expect(css).toBe("/* vendor/fonts.css */\n@font-face { font-family: X }\n");
  });

  test("takes nothing from a page other than the one being rendered", async () => {
    const css = await pageStylesheet(
      options(
        {
          "src/pages/index.astro": 'import "../../vendor/index.css";\n',
          "src/pages/other.astro": 'import "../../vendor/other.css";\n',
          "vendor/index.css": ".index {}\n",
          "vendor/other.css": ".other {}\n",
        },
        {
          cssImports: new Map([
            ["src/pages/index.astro", ["vendor/index.css"]],
            ["src/pages/other.astro", ["vendor/other.css"]],
          ]),
        },
      ),
    );
    expect(css).toContain("/* vendor/index.css */");
    expect(css).not.toContain("/* vendor/other.css */");
  });

  test("says so when a project needs Tailwind and the host did not supply it", async () => {
    await expect(pageStylesheet(options(files, graph))).rejects.toBeInstanceOf(
      TailwindNotConfiguredError,
    );
  });

  test("prefers global.css as the Tailwind entry over an alphabetically earlier file", async () => {
    // Both import Tailwind; only the entry is compiled, so picking the wrong one
    // silently drops the other's @theme and the utilities that read it.
    if (tailwindDir() === null) return;
    const css = await pageStylesheet({
      ...options({
        "src/styles/a-first.css": '@import "tailwindcss";\n@theme { --color-beta: #123456; }\n',
        "src/styles/global.css": '@import "tailwindcss";\n@theme { --color-alpha: #654321; }\n',
        "src/pages/index.astro": '<p class="text-alpha text-beta">hi</p>',
      }),
      html: '<p class="text-alpha text-beta">hi</p>',
      tailwind: await tailwindStylesheets(),
    });
    expect(css).toContain(".text-alpha");
    expect(css).not.toContain(".text-beta");
  });
});

describe("pageStylesheet — Tailwind's content is the rendered HTML", () => {
  const files = {
    "src/styles/global.css": '@import "tailwindcss";\n',
    "src/pages/index.astro": '<p class="mt-4">{label}</p>',
  };

  test("builds what the page rendered, not what the sources mention", async () => {
    if (tailwindDir() === null) return;
    const css = await pageStylesheet({
      ...options(files),
      html: '<p class="underline">x</p>',
      tailwind: await tailwindStylesheets(),
    });
    // `mt-4` is in the source and not on the page, so it is not in the page's CSS —
    // which is the whole saving. `underline` only exists in the rendered output.
    expect(css).toContain(".underline");
    expect(css).not.toContain(".mt-4");
  });
});

describe("tailwindEntry", () => {
  test("names the entry, and nothing when no stylesheet imports Tailwind", () => {
    const files = new Map([
      ["src/styles/a-first.css", ".a {}\n"],
      ["src/styles/global.css", '@import "tailwindcss";\n'],
    ]);
    expect(tailwindEntry({ files, srcDir: "src" })).toBe("src/styles/global.css");
    expect(tailwindEntry({ files: new Map([["src/a.css", ".a {}"]]), srcDir: "src" })).toBeNull();
  });
});
