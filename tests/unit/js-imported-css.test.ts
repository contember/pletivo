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
  dynamicGraphOf,
  getJsImportedCssOutput,
  restoreDynamicGraph,
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

  test("a `?inline`, `?raw` or `?url` CSS import is a string, not a stylesheet of the page", async () => {
    await write("vendor/linked.css", `.linked-css { color: red; }`);
    for (const query of ["inline", "raw", "url"]) await write(`vendor/${query}.css`, `.${query}-css { color: red; }`);
    const sourceFile = path.join(root, "src/pages/index.astro");
    await collectCssSideEffectImports(
      sourceFile,
      [
        `import a from "../../vendor/inline.css?inline";`,
        `import b from "../../vendor/raw.css?raw";`,
        `import c from "../../vendor/url.css?url";`,
        `import "../../vendor/linked.css";`,
      ].join("\n"),
      "astro:index",
    );
    const css = await getJsImportedCssOutput();
    expect(css).toContain(".linked-css");
    for (const query of ["inline", "raw", "url"]) expect(css).not.toContain(`.${query}-css`);
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

  describe("graph modules restored for a page taken from the incremental cache", () => {
    const css = (file: string) => ({ type: "css" as const, file, dynamic: false });

    test("ships a recorded stylesheet and the stored text of an in-memory one", async () => {
      await write("vendor/dyn.css", `.dyn-restored { color: red; }`);
      const virtual = path.join(root, "src/Dyn.svelte.pletivo-style.css");
      const stored = new Map([[virtual, ".svelte-restored{color:blue}"]]);
      restoreDynamicGraph(
        [{ file: path.join(root, "src/Dyn.svelte"), items: [css(path.join(root, "vendor/dyn.css")), css(virtual)] }],
        (file) => stored.get(file),
      );
      const out = await getJsImportedCssOutput();
      expect(out).toContain(".dyn-restored");
      expect(out).toContain(".svelte-restored");
    });

    test("drops a recorded stylesheet deleted since, instead of failing the bundle", async () => {
      await write("vendor/kept.css", `.kept-restored { color: red; }`);
      restoreDynamicGraph(
        [{ file: path.join(root, "src/Dyn.svelte"), items: [css(path.join(root, "vendor/gone.css")), css(path.join(root, "vendor/kept.css"))] }],
        () => undefined,
      );
      expect(await getJsImportedCssOutput()).toContain(".kept-restored");
    });

    test("keeps the text a component compiled this build over the stored one", async () => {
      const file = path.join(root, "src/Dyn.svelte.pletivo-style.css");
      setVirtualCss(file, ".fresh-text{color:blue}");
      restoreDynamicGraph([{ file: path.join(root, "src/Dyn.svelte"), items: [css(file)] }], () => ".stale-text{color:blue}");
      const out = await getJsImportedCssOutput();
      expect(out).toContain(".fresh-text");
      expect(out).not.toContain(".stale-text");
    });

    test("does not record a module the page imports both ways, whichever comes first", async () => {
      await write("vendor/d.css", `.both-ways { color: red; }`);
      await write("src/D.js", `import "../vendor/d.css";\nexport default "d";`);
      const page = path.join(root, "src/pages/index.astro");
      await collectCssSideEffectImports(page, `const later = () => import("../D.js");\nimport D from "../D.js";`, "astro:index");
      expect(dynamicGraphOf(page, []).nodes).toEqual([]);
    });

    test("keeps a module loaded this build over the recorded one", async () => {
      await write("vendor/fresh.css", `.fresh-node { color: red; }`);
      await write("vendor/stale.css", `.stale-node { color: red; }`);
      const module = path.join(root, "src/Dyn.astro");
      await collectCssSideEffectImports(module, `import "../vendor/fresh.css";`, "astro:Dyn.astro");
      restoreDynamicGraph([{ file: module, items: [css(path.join(root, "vendor/stale.css"))] }], () => undefined);
      const out = await getJsImportedCssOutput();
      expect(out).toContain(".fresh-node");
      expect(out).not.toContain(".stale-node");
    });
  });
});
