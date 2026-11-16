/**
 * A `.astro` page importing a component of a framework Astro renders through a
 * renderer (Svelte, Vue, React, Preact, Solid) fails by name when the page is
 * loaded. Before, a `.svelte` file rendered as a tag named by its path, React
 * threw from inside its hooks and Solid from a missing `jsxDEV` export.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import path from "path";
import { registerAstroPlugin } from "../../packages/pletivo/src/astro-plugin";
import { __resetForTests, initAstroHost } from "../../packages/pletivo/src/astro-host/runner";
import { renderAstroPage, isAstroComponent } from "@pletivo/runtime/astro-shim";

let dir: string;

function write(file: string, contents: string): string {
  const absolute = path.join(dir, file);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
  return absolute;
}

/** A page at `src/pages/<name>.astro` rendering `<Counter />` imported from `specifier`. */
function page(name: string, specifier: string): string {
  return write(
    `src/pages/${name}.astro`,
    `---\nimport Counter from "${specifier}";\n---\n<main><Counter /></main>\n`,
  );
}

function rel(file: string): string {
  return path.relative(process.cwd(), path.join(dir, file));
}

beforeAll(async () => {
  // Inside the repo, so a component without its own tsconfig gets the repo's
  // (jsxImportSource "pletivo"), like a pletivo project's component would.
  dir = mkdtempSync(path.join(import.meta.dir, "tmp-framework-components-"));
  await registerAstroPlugin();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("a .astro page importing a framework component", () => {
  test("refuses a Svelte component by its extension", async () => {
    write("src/components/Counter.svelte", "<button>+</button>\n");
    const file = page("svelte", "../components/Counter.svelte");
    await expect(import(file)).rejects.toThrow(
      `pletivo cannot render Svelte components: ${rel("src/components/Counter.svelte")}, imported by ${rel("src/pages/svelte.astro")}`,
    );
  });

  test("refuses JSX compiled for React by a @jsxImportSource pragma", async () => {
    write(
      "src/components/ReactCounter.tsx",
      `/** @jsxImportSource react */\nexport default function Counter() { return <button>+</button>; }\n`,
    );
    const file = page("react", "../components/ReactCounter");
    await expect(import(file)).rejects.toThrow(
      `pletivo cannot render React components: ${rel("src/components/ReactCounter.tsx")} (jsxImportSource "react", set by its @jsxImportSource pragma)`,
    );
  });

  test("refuses JSX compiled for Solid by a tsconfig it extends", async () => {
    write("solid/tsconfig.base.json", `{\n  // Solid specific settings\n  "compilerOptions": { "jsx": "preserve", "jsxImportSource": "solid-js", },\n}\n`);
    write("solid/tsconfig.json", `{ "extends": "./tsconfig.base", "compilerOptions": { "strict": true } }\n`);
    write("solid/src/components/Counter.tsx", `export default function Counter() { return <button>+</button>; }\n`);
    const file = write(
      "solid/src/pages/index.astro",
      `---\nimport Counter from "../components/Counter";\n---\n<main><Counter /></main>\n`,
    );
    await expect(import(file)).rejects.toThrow(
      `pletivo cannot render Solid components: ${rel("solid/src/components/Counter.tsx")} (jsxImportSource "solid-js", set by ${rel("solid/tsconfig.json")})`,
    );
  });

  test("renders JSX compiled for pletivo, as before", async () => {
    write("src/components/Greeting.tsx", `export default function Greeting() { return <b>hi</b>; }\n`);
    const mod = await import(page("pletivo", "../components/Greeting"));
    expect(isAstroComponent(mod.default)).toBe(true);
    expect(await renderAstroPage(mod.default, {})).toContain("<main><b>hi</b></main>");
  });
});

describe("an integration registering a renderer", () => {
  test("is warned about by name, since pletivo ignores the renderer", async () => {
    const root = path.join(dir, "renderer");
    mkdirSync(root, { recursive: true });
    writeFileSync(
      path.join(root, "astro.config.mjs"),
      `export default { integrations: [{ name: "svelte-like", hooks: { "astro:config:setup": ({ addRenderer }) => addRenderer({ name: "@astrojs/svelte", serverEntrypoint: "x" }) } }] }\n`,
    );
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      __resetForTests();
      await initAstroHost(root, "build");
      expect(warn.mock.calls.map((call) => String(call[0]))).toContain(
        '  [svelte-like] renderer "@astrojs/svelte" ignored: pletivo does not implement Astro framework renderers',
      );
    } finally {
      warn.mockRestore();
      __resetForTests();
    }
  });
});
