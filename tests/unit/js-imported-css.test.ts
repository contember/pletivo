import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  clearJsImportedCss,
  clearJsImportedCssImportCache,
  collectCssSideEffectImports,
  collectPageModuleCss,
  configureJsImportedCss,
  getJsImportedCssOutput,
  restoreDynamicCss,
  setVirtualCss,
} from "../../packages/pletivo/src/js-imported-css";

let root = "";

async function write(rel: string, content: string): Promise<void> {
  const file = path.join(root, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

describe("JS-imported CSS collection", () => {
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "pletivo-js-css-"));
    configureJsImportedCss(root, "src");
  });

  afterEach(async () => {
    clearJsImportedCss();
    await fs.rm(root, { recursive: true, force: true });
  });

  test("clears transitive static import cache after a JS edit", async () => {
    await write("src/pages/index.astro", "");
    await write("src/entry.js", `import "./dep.js";`);
    await write("src/dep.js", `export const marker = "v1";`);
    await write("vendor/external.css", `.external-side-effect-css { color: red; }`);

    const sourceFile = path.join(root, "src/pages/index.astro");
    await collectCssSideEffectImports(sourceFile, `import "../entry.js";`, "astro:index");
    expect(await getJsImportedCssOutput()).not.toContain(".external-side-effect-css");

    await write("src/dep.js", `import "../vendor/external.css";`);
    await collectCssSideEffectImports(sourceFile, `import "../entry.js";`, "astro:index");
    expect(await getJsImportedCssOutput()).not.toContain(".external-side-effect-css");

    clearJsImportedCssImportCache();
    await collectCssSideEffectImports(sourceFile, `import "../entry.js";`, "astro:index");
    expect(await getJsImportedCssOutput()).toContain(".external-side-effect-css");
  });

  test("collectPageModuleCss picks up external CSS from a non-.astro page module", async () => {
    await write("vendor/ext.css", `.tsx-external-side-effect-css { color: red; }`);
    await write(
      "src/pages/index.tsx",
      `import "../../vendor/ext.css";\nexport default function Index() { return { __html: "" }; }`,
    );

    await collectPageModuleCss(path.join(root, "src/pages/index.tsx"), "page:index.tsx");
    expect(await getJsImportedCssOutput()).toContain(".tsx-external-side-effect-css");
  });

  test("does not treat a JS package with a /css subpath as CSS", async () => {
    await write(
      "node_modules/fake-emotion/package.json",
      `{ "name": "fake-emotion", "exports": { "./css": "./css.js" } }`,
    );
    await write("node_modules/fake-emotion/css.js", `export const css = () => "cls";`);
    await write(
      "src/pages/index.tsx",
      `import { css } from "fake-emotion/css";\nexport default function Index() { return { __html: css() }; }`,
    );

    await collectPageModuleCss(path.join(root, "src/pages/index.tsx"), "page:index.tsx");
    expect(await getJsImportedCssOutput()).toBe("");
  });

  describe("CSS restored for a page taken from the incremental cache", () => {
    test("ships a recorded stylesheet and the stored text of an in-memory one", async () => {
      await write("vendor/dyn.css", `.dyn-restored { color: red; }`);
      const stored = new Map([[path.join(root, "src/Dyn.svelte.pletivo-style.css"), ".svelte-restored{color:blue}"]]);
      restoreDynamicCss("index::__static__", [path.join(root, "vendor/dyn.css"), ...stored.keys()], (file) => stored.get(file));
      const css = await getJsImportedCssOutput();
      expect(css).toContain(".dyn-restored");
      expect(css).toContain(".svelte-restored");
    });

    test("drops a recorded stylesheet deleted since, instead of failing the bundle", async () => {
      await write("vendor/kept.css", `.kept-restored { color: red; }`);
      restoreDynamicCss("index::__static__", [path.join(root, "vendor/gone.css"), path.join(root, "vendor/kept.css")], () => undefined);
      expect(await getJsImportedCssOutput()).toContain(".kept-restored");
    });

    test("keeps the text a component compiled this build over the stored one", async () => {
      const file = path.join(root, "src/Dyn.svelte.pletivo-style.css");
      setVirtualCss(file, ".fresh-text{color:blue}");
      restoreDynamicCss("index::__static__", [file], () => ".stale-text{color:blue}");
      const css = await getJsImportedCssOutput();
      expect(css).toContain(".fresh-text");
      expect(css).not.toContain(".stale-text");
    });
  });
});
