import { afterAll, describe, expect, test } from "bun:test";
import { imageContentHash } from "@pletivo/core/image";
import { createAstroCompiler } from "../src/astro-compiler.ts";
import { createCompileCache } from "../src/compile-cache.ts";
import { expandImportMetaGlobs, extractImportMetaGlobs } from "../src/compile/import-meta-glob.ts";
import { ContentFiles, createProjectAssetsView } from "../src/content-files.ts";
import { renderPage } from "../src/render.ts";
import { astroWasmModule } from "./astro-wasm.ts";
import { FileLoader } from "./file-loader.ts";

describe("import.meta.glob, compiled", () => {
  test("a call becomes a placeholder that keeps its literal arguments", () => {
    const { code, globs } = extractImportMetaGlobs(
      `const all = import.meta.glob(["/src/a/*.ts", "!/src/a/skip.ts"], { eager: true, import: "default" });\n`,
      "src/lib/x.ts",
    );
    expect(code).toBe("const all = __pletivo_import_meta_glob_0__;\n");
    expect(globs).toEqual([{
      placeholder: "__pletivo_import_meta_glob_0__",
      patterns: ["/src/a/*.ts", "!/src/a/skip.ts"],
      eager: true,
      importName: "default",
      query: null,
    }]);
  });

  test("code without a call is left untouched", () => {
    const source = `export const meta = import.meta.url;\n`;
    expect(extractImportMetaGlobs(source, "src/x.ts")).toEqual({ code: source, globs: [] });
  });

  test("a pattern that is not a literal is refused by name", () => {
    expect(() => extractImportMetaGlobs(`import.meta.glob(pattern);\n`, "src/x.ts")).toThrow(
      /src\/x\.ts.*import\.meta\.glob: the pattern must be a string literal/,
    );
    expect(() => extractImportMetaGlobs(`import.meta.glob("/a/*", { base: "/x" });\n`, "src/x.ts")).toThrow(
      /option "base"/,
    );
  });

  test("an eager glob imports each match and keys it the way it was written", () => {
    const { code, globs } = extractImportMetaGlobs(
      `export const abs = import.meta.glob("/src/data/*.ts", { eager: true });\n` +
        `export const rel = import.meta.glob("../data/*.ts", { eager: true, import: "default" });\n`,
      "src/lib/x.ts",
    );
    const expanded = expandImportMetaGlobs(code, globs, "src/lib/x.ts", ["src/data/b.ts", "src/data/a.ts", "src/lib/x.ts"]);
    expect(expanded.specifiers).toEqual(["../data/a.ts", "../data/b.ts", "../data/a.ts", "../data/b.ts"]);
    expect(expanded.code).toBe(
      `import * as __pletivo_glob_0_0 from "../data/a.ts";\n` +
        `import * as __pletivo_glob_0_1 from "../data/b.ts";\n` +
        `import * as __pletivo_glob_1_0 from "../data/a.ts";\n` +
        `import * as __pletivo_glob_1_1 from "../data/b.ts";\n` +
        `export const abs = {"/src/data/a.ts": __pletivo_glob_0_0, "/src/data/b.ts": __pletivo_glob_0_1};\n` +
        `export const rel = {"../data/a.ts": __pletivo_glob_1_0["default"], "../data/b.ts": __pletivo_glob_1_1["default"]};\n`,
    );
  });

  test("a lazy glob loads each match on demand, the importer and excluded files left out", () => {
    const { code, globs } = extractImportMetaGlobs(
      `export const pages = import.meta.glob(["./*.ts", "!./skip.ts"], { query: "?raw", import: "default" });\n`,
      "src/x.ts",
    );
    const expanded = expandImportMetaGlobs(code, globs, "src/x.ts", ["src/x.ts", "src/y.ts", "src/skip.ts", "src/.hidden.ts"]);
    expect(expanded.specifiers).toEqual(["./y.ts?raw"]);
    expect(expanded.code).toBe(
      `export const pages = {"./y.ts": () => import("./y.ts?raw").then((module) => module["default"])};\n`,
    );
  });

  test("a pattern without a root or relative prefix is refused", () => {
    const { code, globs } = extractImportMetaGlobs(`import.meta.glob("@/data/*.ts");\n`, "src/x.ts");
    expect(() => expandImportMetaGlobs(code, globs, "src/x.ts", [])).toThrow(/must start with "\/", "\.\/" or "\.\.\/"/);
  });
});

// ── End to end, on Bun ──────────────────────────────────────────────

const compiler = createAstroCompiler(await astroWasmModule());
const loader = new FileLoader();
afterAll(() => loader.cleanup());

/** A 4×4 PNG, as in `images.test.ts`. */
const PNG_4x4 = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFElEQVR4nGP8z4A" +
      "AjEwMDAwMDAwMDAAOKgIBIfBvXQAAAABJRU5ErkJggg==",
  ),
  (character) => character.charCodeAt(0),
);

const CONTENT_FILES = new ContentFiles();
const EXECUTION_NAMESPACE = { tenant: "glob-tests", capabilityGeneration: "content-v1" };

describe("import.meta.glob in the isolate", () => {
  test("eager image globs resolve to the same metadata an import does", async () => {
    const page = await renderPage({
      files: new Map([
        [
          "src/pages/index.astro",
          `---
const photos = import.meta.glob("/src/assets/*.png", { eager: true });
---
<ul>{Object.entries(photos).map(([key, module]) => <li data-key={key}>{module.default.src} {module.default.width}</li>)}</ul>
`,
        ],
      ]),
      assets: createProjectAssetsView(new Map([["src/assets/a.png", PNG_4x4], ["src/assets/b.png", PNG_4x4]])),
      pathname: "/",
      loader,
      compiler,
      content: { binding: CONTENT_FILES, store: CONTENT_FILES },
      executionNamespace: EXECUTION_NAMESPACE,
    });
    const hash = imageContentHash(PNG_4x4);
    expect(page.html).toContain(`<li data-key="/src/assets/a.png">/_astro/a.${hash}.png 4</li>`);
    expect(page.html).toContain(`<li data-key="/src/assets/b.png">/_astro/b.${hash}.png 4</li>`);
  });

  test("a file added between renders joins the glob without a recompile", async () => {
    const cache = createCompileCache();
    const page = `---
const notes = import.meta.glob("../notes/*.ts", { import: "default" });
const loaded = await Promise.all(Object.values(notes).map((load) => load()));
---
<p>{Object.keys(notes).join(",")}={loaded.join(",")}</p>
`;
    const render = (files: Map<string, string>) =>
      renderPage({
        files,
        pathname: "/",
        loader,
        compiler,
        compileCache: cache,
        content: { binding: CONTENT_FILES, store: CONTENT_FILES },
        executionNamespace: EXECUTION_NAMESPACE,
      });
    const first = new Map([["src/pages/index.astro", page], ["src/notes/a.ts", `export default "A";\n`]]);
    expect((await render(first)).html).toContain("<p>../notes/a.ts=A</p>");

    const cached = cache.get("src/pages/index.astro");
    const second = new Map([...first, ["src/notes/b.ts", `export default "B";\n`]]);
    expect((await render(second)).html).toContain("<p>../notes/a.ts,../notes/b.ts=A,B</p>");
    expect(cache.get("src/pages/index.astro")).toBe(cached);
  });
});
