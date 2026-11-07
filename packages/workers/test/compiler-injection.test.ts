import { parse, transform } from "@astrojs/compiler";
import { expect, test } from "bun:test";
import { compileProject } from "../src/compile-project.ts";
import { createProjectAssetsView } from "../src/content-files.ts";

// `AstroCompiler` has `@astrojs/compiler`'s own shape, so a host may pass the module itself.
test("@astrojs/compiler passed as the compiler compiles a page the shim can load", async () => {
  const compiled = await compileProject({
    files: new Map([["src/pages/index.astro", "<h1>hi</h1>\n"]]),
    entries: ["src/pages/index.astro"],
    assets: createProjectAssetsView(new Map()),
    srcDir: "src",
    compiler: { transform, parse },
  });

  const modules = Object.values(compiled.program.modules);
  expect(modules.some((code) => code.includes("<h1>hi</h1>"))).toBe(true);
  // The compiler's own metadata import names an export the shim does not have.
  expect(modules.filter((code) => code.includes("createMetadata"))).toEqual([]);
});
