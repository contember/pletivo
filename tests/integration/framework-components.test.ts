/**
 * A `.astro` page importing a component of a framework Astro renders through a
 * renderer (Svelte, Vue, React, Preact, Solid) fails by name when the page is
 * loaded and the project registers no renderer for it; the error names the
 * integration that would. Before, a `.svelte` file rendered as a tag named by its
 * path, React threw from inside its hooks and Solid from a missing `jsxDEV` export.
 * Rendering through a registered renderer: astro-framework-renderers.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import path from "path";
import { registerAstroPlugin } from "../../packages/pletivo/src/astro-plugin";
import { __resetForTests } from "../../packages/pletivo/src/astro-host/runner";
import { build } from "../../packages/pletivo/src/build";
import type { PletivoConfig } from "../../packages/pletivo/src/config";
import { renderAstroPage, isAstroComponent } from "@pletivo/runtime/astro-shim";

let dir: string;

const config: PletivoConfig = {
  host: "localhost",
  outDir: "dist",
  port: 3000,
  base: "/",
  srcDir: "src",
  publicDir: "public",
};

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

  test("refuses a Vue component by its extension", async () => {
    write("src/components/Counter.vue", "<template><button>+</button></template>\n");
    await expect(import(page("vue", "../components/Counter.vue"))).rejects.toThrow(
      `pletivo cannot render Vue components: ${rel("src/components/Counter.vue")}, imported by ${rel("src/pages/vue.astro")}`,
    );
  });

  test("lists every refused import in one error", async () => {
    write("src/components/A.svelte", "<b>a</b>\n");
    write("src/components/B.tsx", `/** @jsxImportSource preact */\nexport default function B() { return <b>b</b>; }\n`);
    const file = write(
      "src/pages/several.astro",
      `---\nimport A from "../components/A.svelte";\nimport B from "../components/B";\n---\n<A /><B />\n`,
    );
    const error = await import(file).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    const lines = error instanceof Error ? error.message.split("\n") : [];
    expect(lines[0]).toStartWith(`pletivo cannot render Svelte components: ${rel("src/components/A.svelte")}`);
    expect(lines[1]).toStartWith(`pletivo cannot render Preact components: ${rel("src/components/B.tsx")}`);
    expect(lines[2]).toBe(
      "Astro renders these through the renderer of the framework's integration; add @astrojs/svelte, @astrojs/preact to the integrations in astro.config.",
    );
  });

  test("takes the last entry of an extends array, as TypeScript does", async () => {
    write("order/solid.json", `{ "compilerOptions": { "jsxImportSource": "solid-js" } }\n`);
    write("order/react.json", `{ "compilerOptions": { "jsxImportSource": "react" } }\n`);
    write("order/tsconfig.json", `{ "extends": ["./solid.json", "./react.json"] }\n`);
    write("order/src/components/Counter.tsx", `export default function Counter() { return <b>+</b>; }\n`);
    const file = write("order/src/pages/index.astro", `---\nimport Counter from "../components/Counter";\n---\n<Counter />\n`);
    await expect(import(file)).rejects.toThrow(`pletivo cannot render React components: ${rel("order/src/components/Counter.tsx")}`);
  });

  test("renders JSX compiled for pletivo, as before", async () => {
    write("src/components/Greeting.tsx", `export default function Greeting() { return <b>hi</b>; }\n`);
    const mod = await import(page("pletivo", "../components/Greeting"));
    expect(isAstroComponent(mod.default)).toBe(true);
    expect(await renderAstroPage(mod.default, {})).toContain("<main><b>hi</b></main>");
  });

  test("renders a pletivo pragma over a tsconfig that says react", async () => {
    // Extends the repo's tsconfig for its `pletivo/jsx-runtime` path mapping.
    write(
      "pragma/tsconfig.json",
      JSON.stringify({ extends: path.join(import.meta.dir, "../../tsconfig.json"), compilerOptions: { jsxImportSource: "react" } }),
    );
    write("pragma/src/components/Greeting.tsx", `/** @jsxImportSource pletivo */\nexport default function Greeting() { return <b>hi</b>; }\n`);
    const file = write("pragma/src/pages/index.astro", `---\nimport Greeting from "../components/Greeting";\n---\n<main><Greeting /></main>\n`);
    const mod = await import(file);
    expect(await renderAstroPage(mod.default, {})).toContain("<main><b>hi</b></main>");
  });

  test("renders a pletivo pragma below a directive, which Bun honours, over a react tsconfig", async () => {
    write(
      "pragma-late/tsconfig.json",
      JSON.stringify({ extends: path.join(import.meta.dir, "../../tsconfig.json"), compilerOptions: { jsxImportSource: "react" } }),
    );
    write(
      "pragma-late/src/components/Greeting.tsx",
      `"use client";\n/** @jsxImportSource pletivo */\nexport default function Greeting() { return <b>hi</b>; }\n`,
    );
    const file = write("pragma-late/src/pages/index.astro", `---\nimport Greeting from "../components/Greeting";\n---\n<main><Greeting /></main>\n`);
    const mod = await import(file);
    expect(await renderAstroPage(mod.default, {})).toContain("<main><b>hi</b></main>");
  });

  test("leaves a package's component to the runtime", async () => {
    // Under node_modules the project's tsconfig does not apply; a package ships what it compiled.
    write("node_modules/ui-kit/Label.tsx", `/** @jsxImportSource react */\nexport default function Label() { return "label"; }\n`);
    const mod = await import(page("package", "../../node_modules/ui-kit/Label.tsx"));
    expect(await renderAstroPage(mod.default, {})).toContain("<main>label</main>");
  });
});

describe("a project whose integration registers a renderer", () => {
  test("fails the build, naming the renderer, when its serverEntrypoint does not resolve", async () => {
    const root = path.join(dir, "renderer");
    write(
      "renderer/astro.config.mjs",
      `export default { integrations: [{ name: "react-like", hooks: { "astro:config:setup": ({ addRenderer }) => addRenderer({ name: "@astrojs/react", serverEntrypoint: "x" }) } }] }\n`,
    );
    write("renderer/src/components/Greeting.tsx", `export default function Greeting() { return <b>hi</b>; }\n`);
    write("renderer/src/pages/index.astro", `---\nimport Greeting from "../components/Greeting";\n---\n<main><Greeting /></main>\n`);
    __resetForTests();
    try {
      await expect(build(root, config)).rejects.toThrow(
        `renderer "@astrojs/react": its serverEntrypoint x cannot be resolved from ${root}`,
      );
    } finally {
      __resetForTests();
    }
  });
});
