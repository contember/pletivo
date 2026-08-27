import { describe, expect, test } from "bun:test";
import type { InjectedScripts, ModuleId } from "@pletivo/core/artifact";
import type { ResolvedStyleGraph } from "../src/compiled-program.ts";
import {
  TailwindNotConfiguredError,
  pageStylesheet,
  tailwindEntry,
  type PageStylesheetOptions,
} from "../src/project-css.ts";
import { tailwindDir, tailwindStylesheets } from "./tailwind-sources.ts";

const PAGE = "project:src/pages/index.astro";

function graph(
  modules: ModuleId[],
  executionEdges: ResolvedStyleGraph["executionEdges"] = [],
  styleEdges: ResolvedStyleGraph["styleEdges"] = [],
): ResolvedStyleGraph {
  return { modules, executionEdges, styleEdges, styles: [] };
}

function options(
  files: Record<string, string>,
  styleGraph: ResolvedStyleGraph,
  overrides: Partial<PageStylesheetOptions> = {},
): PageStylesheetOptions {
  return {
    files: new Map(Object.entries(files)),
    srcDir: "src",
    rootDir: "",
    styleGraph,
    entry: PAGE,
    html: "",
    ...overrides,
  };
}

describe("pageStylesheet canonical graph", () => {
  test("returns null when the page graph reaches no CSS", async () => {
    expect(await pageStylesheet(options({}, graph([PAGE])))).toBeNull();
  });

  test("uses artifact/package CSS edges and preserves equal-specificity cascade order", async () => {
    const layout = "npm:layout/index.js";
    const first = "npm:theme/first.css";
    const second = "npm:theme/second.css";
    const css = await pageStylesheet(options(
      {
        [first]: ".same { color: red }",
        [second]: ".same { color: blue }",
      },
      graph(
        [PAGE, layout, first, second],
        [{ importer: PAGE, target: layout }],
        [
          { importer: layout, target: first },
          { importer: PAGE, target: second },
        ],
      ),
    ));
    expect(css).toBe(
      `/* ${first} */\n.same { color: red }\n\n/* ${second} */\n.same { color: blue }`,
    );
  });

  test("collects an opaque artifact stylesheet id without guessing its extension", async () => {
    const opaque = "npm:theme/2dd4a8";
    const css = await pageStylesheet(options(
      { [opaque]: ".opaque { color: purple }" },
      graph([PAGE, opaque], [], [{ importer: PAGE, target: opaque }]),
    ));
    expect(css).toBe(`/* ${opaque} */\n.opaque { color: purple }`);
  });

  test("emits a shared stylesheet once at its first canonical position", async () => {
    const left = "project:src/lib/left.js";
    const right = "project:src/lib/right.js";
    const shared = "project:src/styles/shared.css";
    const css = await pageStylesheet(options(
      { "src/styles/shared.css": ".shared {}" },
      graph(
        [PAGE, left, right, shared],
        [
          { importer: PAGE, target: left },
          { importer: PAGE, target: right },
        ],
        [
          { importer: left, target: shared },
          { importer: right, target: shared },
        ],
      ),
    ));
    expect(css?.match(/\.shared/g)).toHaveLength(1);
  });

  test("keeps CSS modules absent instead of inventing a shim", async () => {
    const moduleCss = "project:src/Card.module.css";
    expect(await pageStylesheet(options(
      { "src/Card.module.css": ".card {}" },
      graph([PAGE, moduleCss], [], [{ importer: PAGE, target: moduleCss }]),
    ))).toBeNull();
  });
});

describe.skipIf(tailwindDir() === null)("pageStylesheet Tailwind closure", () => {
  const entry = "project:src/styles/global.css";
  const tokens = "project:src/styles/tokens.css";

  async function productionTailwindGraph(
    pageEdges: ResolvedStyleGraph["styleEdges"] = [{ importer: PAGE, target: entry }],
  ): Promise<{ files: Record<string, string>; graph: ResolvedStyleGraph }> {
    const embedded = await tailwindStylesheets();
    const tailwindPackage = "npm:tailwindcss/root";
    return {
      files: {
        "src/styles/global.css": '@import "tailwindcss";\n@import "./tokens.css";\n.entry-sentinel { --entry: 1; }',
        "src/styles/tokens.css": "@theme { --spacing-special: 3rem; }\n.dep-sentinel { --dep: 1; }",
        [tailwindPackage]: embedded.tailwindcss,
      },
      graph: graph(
        [PAGE, tailwindPackage, tokens, entry],
        [],
        [
          ...pageEdges,
          { importer: entry, target: tailwindPackage },
          { importer: entry, target: tokens },
        ],
      ),
    };
  }

  test("does not append the Tailwind entry or imported dependency raw", async () => {
    const production = await productionTailwindGraph();
    const css = await pageStylesheet({
      ...options(production.files, production.graph),
      html: '<div class="p-special"></div>',
      tailwind: await tailwindStylesheets(),
    });
    expect(css?.match(/\.entry-sentinel/g)).toHaveLength(1);
    expect(css?.match(/\.dep-sentinel/g)).toHaveLength(1);
    expect(css).toContain(".p-special");
    expect(css).not.toContain("/* npm:tailwindcss/root */");
    expect(css).not.toContain("/* styles/tokens.css */");
  });

  test("replaces the consumed closure at its canonical before/after position", async () => {
    const before = "npm:theme/before";
    const after = "npm:theme/after";
    const production = await productionTailwindGraph([
      { importer: PAGE, target: before },
      { importer: PAGE, target: entry },
      { importer: PAGE, target: after },
    ]);
    production.files[before] = ".same { color: red }";
    production.files[after] = ".same { color: blue }";
    production.files["src/styles/global.css"] += "\n.same { color: green }";
    production.graph.modules.push(before, after);
    const css = await pageStylesheet({
      ...options(production.files, production.graph),
      tailwind: await tailwindStylesheets(),
    });
    const beforeAt = css?.indexOf("color: red") ?? -1;
    const tailwindAt = css?.indexOf("color: green") ?? -1;
    const afterAt = css?.indexOf("color: blue") ?? -1;
    expect(beforeAt).toBeGreaterThanOrEqual(0);
    expect(tailwindAt).toBeGreaterThan(beforeAt);
    expect(afterAt).toBeGreaterThan(tailwindAt);
  });

  test("rejects a project CSS module inside the Tailwind import closure", async () => {
    const embedded = await tailwindStylesheets();
    const tailwindPackage = "npm:tailwindcss/root";
    const moduleCss = "project:src/styles/card.module.css";
    await expect(pageStylesheet({
      ...options(
        {
          "src/styles/global.css": '@import "tailwindcss";\n@import "./card.module.css";',
          "src/styles/card.module.css": ".card {}",
          [tailwindPackage]: embedded.tailwindcss,
        },
        graph(
          [PAGE, entry, tailwindPackage, moduleCss],
          [],
          [
            { importer: PAGE, target: entry },
            { importer: entry, target: tailwindPackage },
            { importer: entry, target: moduleCss },
          ],
        ),
      ),
      tailwind: embedded,
    })).rejects.toThrow(/CSS module/);
  });

  test("takes candidates from decoded class values and both injected script categories", async () => {
    const production = await productionTailwindGraph();
    const scripts: InjectedScripts = {
      headInline: [`document.body.classList.add("underline")`],
      page: [`node.className = "italic"`],
    };
    const css = await pageStylesheet({
      ...options(
        production.files,
        production.graph,
      ),
      html: `<!-- class="text-red-500" --><style>.mt-8{}</style><p title="font-bold">text-blue-500</p><i class="[&amp;>svg]:block"></i>`,
      scripts,
      tailwind: await tailwindStylesheets(),
    });
    expect(css).toContain(".underline");
    expect(css).toContain(".italic");
    expect(css).toContain("svg");
    expect(css).not.toContain(".text-red-500");
    expect(css).not.toContain(".mt-8");
    expect(css).not.toContain(".font-bold");
    expect(css).not.toContain(".text-blue-500");
  });

  test("fails loudly when Tailwind sources were not embedded", async () => {
    await expect(pageStylesheet(options(
      { "src/styles/global.css": '@import "tailwindcss";' },
      graph([PAGE, entry], [], [{ importer: PAGE, target: entry }]),
    ))).rejects.toBeInstanceOf(TailwindNotConfiguredError);
  });
});

describe("tailwindEntry parity helper", () => {
  test("keeps the source-map scanner only for local parity", () => {
    expect(tailwindEntry({
      files: new Map([["src/styles/global.css", '@import "tailwindcss";']]),
      srcDir: "src",
    })).toBe("src/styles/global.css");
  });
});
