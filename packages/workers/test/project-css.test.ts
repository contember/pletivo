import { describe, expect, test } from "bun:test";
import { md5Hex } from "../src/md5.ts";
import {
  TailwindNotConfiguredError,
  cssRoots,
  projectStylesheet,
  type ProjectCssOptions,
} from "../src/project-css.ts";
import { tailwindStylesheets, tailwindDir } from "./tailwind-sources.ts";

/** `projectStylesheet` inputs with the graph maps empty unless a test fills them. */
function options(
  files: Record<string, string>,
  overrides: Partial<ProjectCssOptions> = {},
): ProjectCssOptions {
  return {
    files: new Map(Object.entries(files)),
    srcDir: "src",
    rootDir: "",
    cssImports: new Map(),
    imports: new Map(),
    roots: [],
    ...overrides,
  };
}

describe("projectStylesheet", () => {
  test("is null when the project has no CSS at all", async () => {
    expect(await projectStylesheet(options({ "src/pages/index.astro": "<p>hi</p>" }))).toBeNull();
  });

  test("concatenates the source tree with a label per file, sorted by path", async () => {
    const sheet = await projectStylesheet(
      options({
        "src/styles/z.css": ".z { color: red }\n",
        "src/styles/a.css": ".a { color: blue }\n",
        "src/pages/index.astro": "<p>hi</p>",
      }),
    );
    expect(sheet?.css).toBe(
      "/* styles/a.css */\n.a { color: blue }\n\n\n/* styles/z.css */\n.z { color: red }\n",
    );
  });

  test("names the file from the md5 of its own bytes, which is what makes the link comparable", async () => {
    const sheet = await projectStylesheet(options({ "src/styles/a.css": ".a { color: red }\n" }));
    expect(sheet).not.toBeNull();
    expect(sheet?.href).toBe(`/assets/styles.${md5Hex(sheet?.css ?? "").slice(0, 8)}.css`);
    expect(sheet?.href).toMatch(/^\/assets\/styles\.[0-9a-f]{8}\.css$/);
  });

  test("leaves CSS modules out — a different pipeline owns them, and it is not ported", async () => {
    expect(
      await projectStylesheet(options({ "src/components/Card.module.css": ".card {}" })),
    ).toBeNull();
  });

  test("takes only the source tree, not the whole file map", async () => {
    const sheet = await projectStylesheet(
      options({ "vendor/outside.css": ".v {}\n", "src/styles/in.css": ".i {}\n" }),
    );
    // `vendor/` reaches the bundle through an import, never through the glob.
    expect(sheet?.css).toBe("/* styles/in.css */\n.i {}\n");
  });
});

describe("projectStylesheet — what the module graph imports", () => {
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
    roots: [{ key: "astro:src/pages/index.astro", file: "src/pages/index.astro" }],
  };

  test("walks transitively through JavaScript and frames out-of-tree CSS the way Bun.build does", async () => {
    const sheet = await projectStylesheet(
      options({ ...files, "src/styles/global.css": ".not-tailwind {}\n" }, graph),
    );
    // Not in Tailwind mode, so the source tree is already whole and only the
    // out-of-tree import is appended — with the file's own bytes, see the header.
    expect(sheet?.css).toEndWith("/* vendor/util.css */\n.vendor { color: rgb(1, 2, 3) }\n");
    expect(sheet?.css).toContain("/* styles/page.css */\n.page {}\n");
  });

  test("appends the imported source CSS verbatim once Tailwind owns the compile pass", async () => {
    if (tailwindDir() === null) return;
    const sheet = await projectStylesheet({
      ...options(files, graph),
      tailwind: await tailwindStylesheets(),
    });
    expect(sheet?.css).toStartWith("/*! tailwindcss v4");
    // Both source stylesheets the graph named, sorted, labelled from the project root,
    // after the out-of-tree bundle.
    expect(sheet?.css).toEndWith(
      "/* src/styles/page.css */\n.page {}\n\n\n/* src/styles/util.css */\n.util {}\n",
    );
    // Never the one nothing imported.
    expect(sheet?.css).not.toContain("/* src/styles/global.css */");
  });

  test("says so when a project needs Tailwind and the host did not supply it", async () => {
    await expect(projectStylesheet(options(files, graph))).rejects.toBeInstanceOf(
      TailwindNotConfiguredError,
    );
  });

  test("prefers global.css as the Tailwind entry over an alphabetically earlier file", async () => {
    // Both import Tailwind; only the entry is compiled, so picking the wrong one
    // silently drops the other's @theme and the utilities that read it.
    if (tailwindDir() === null) return;
    const sheet = await projectStylesheet({
      ...options({
        "src/styles/a-first.css": '@import "tailwindcss";\n@theme { --color-beta: #123456; }\n',
        "src/styles/global.css": '@import "tailwindcss";\n@theme { --color-alpha: #654321; }\n',
        "src/pages/index.astro": '<p class="text-alpha text-beta">hi</p>',
      }),
      tailwind: await tailwindStylesheets(),
    });
    expect(sheet?.css).toContain(".text-alpha");
    expect(sheet?.css).not.toContain(".text-beta");
  });
});

describe("cssRoots", () => {
  test("takes every .astro file a page reaches, and every page module that is not .astro or .md", () => {
    const roots = cssRoots({
      pages: new Map([
        ["src/pages/index.astro", "index.astro"],
        ["src/pages/list.tsx", "list.tsx"],
        ["src/pages/post.md", "post.md"],
      ]),
      imports: new Map([
        ["src/pages/index.astro", ["src/components/Layout.astro"]],
        ["src/components/Layout.astro", ["src/components/Note.astro"]],
        ["src/pages/list.tsx", ["src/components/Card.astro"]],
      ]),
    });
    expect(roots.map((root) => root.key)).toEqual([
      "astro:src/components/Card.astro",
      "astro:src/components/Layout.astro",
      "astro:src/components/Note.astro",
      "astro:src/pages/index.astro",
      "page:list.tsx",
    ]);
  });

  test("leaves out a component no page imports", () => {
    const roots = cssRoots({
      pages: new Map([["src/pages/index.astro", "index.astro"]]),
      imports: new Map(),
    });
    expect(roots.map((root) => root.file)).toEqual(["src/pages/index.astro"]);
  });
});
