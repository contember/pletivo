import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import path from "path";
import { __resetForTests } from "../../packages/pletivo/src/astro-host/runner";
import { prepare } from "../../packages/pletivo/src/prepare/index";
import type { PreparedSite } from "@pletivo/core/artifact";

/**
 * `pletivo prepare` against the fixture the Workers host renders from
 * (`packages/workers/test/fixture-vendor`), which is deliberately shaped like
 * astro-icon: a package that ships `.astro`, a Vite plugin whose `load()` returns a
 * JSON literal computed off disk, and an `injectScript`.
 *
 * The assertions are on what came out, not on it having run — a prepare that silently
 * carries nothing produces a bundle that fails at the Loader with no mention of the
 * artifact at all.
 */

const fixtureRoot = path.resolve(import.meta.dir, "../../packages/workers/test/fixture-vendor");
let prepared: PreparedSite;

describe("pletivo prepare", () => {
  beforeAll(async () => {
    __resetForTests();
    prepared = await prepare(fixtureRoot);
  });

  afterAll(() => {
    __resetForTests();
  });

  test("freezes the config fields a render reads", () => {
    expect(prepared.artifact.config.site).toBe("https://vendor.example");
    expect(prepared.artifact.config.base).toBe("/");
    expect(prepared.artifact.config.trailingSlash).toBe("ignore");
  });

  test("freezes injectScript bodies as the strings they already are", () => {
    expect(prepared.artifact.scripts.headInline).toEqual(['window.__vendorDemo = "ready";\n']);
    expect(prepared.artifact.scripts.page).toEqual([]);
  });

  test("carries a package that ships .astro as sources, keyed by its own path", () => {
    const sources = prepared.artifact.generatedSources;
    expect(Object.keys(sources).sort()).toEqual([
      "node_modules/pletivo-vendor-demo/components/Badge.astro",
      "node_modules/pletivo-vendor-demo/components/index.ts",
      "node_modules/pletivo-vendor-demo/components/palette.ts",
    ]);
    expect(sources["node_modules/pletivo-vendor-demo/components/Badge.astro"]).toContain("<style>");
  });

  test("bundles a plain-JavaScript package into one module", () => {
    const name = prepared.artifact.vendor["pletivo-vendor-demo"];
    expect(name).toBe("vendor.pletivo-vendor-demo.js");
    const code = prepared.modules[name];
    // The entry and the file it imports, in one module: nothing is left pointing at
    // node_modules, because the isolate has none.
    expect(code).toContain("slugLabel");
    expect(code).toContain("toUpperCase");
    expect(code).not.toContain("./internal/title-case.js");
  });

  test("bundles a package for the names that import it, and nothing else", () => {
    const code = prepared.modules[prepared.artifact.vendor["pletivo-vendor-demo"]];
    // Not only smaller: pointed at `@iconify/utils`' own entry, `Bun.build` writes an
    // export clause naming 83 functions and defines a handful, and the Loader then
    // refuses the bundle. A generated `export { … } from` entry does not reach that.
    expect(code).not.toContain("unusedHelper");
  });

  test("redirects a package's `./x.js` to the `x.ts` it actually lands on", () => {
    expect(prepared.artifact.vendor["node_modules/pletivo-vendor-demo/components/palette.js"]).toBe(
      "node_modules/pletivo-vendor-demo/components/palette.ts",
    );
  });

  test("freezes the virtual module the vendored component imports", () => {
    const name = prepared.artifact.virtualModules["virtual:vendor-demo"];
    expect(name).toBe("virtual.virtual_vendor-demo.js");
    // The plugin read tones.json off disk at prepare time; the isolate gets the result,
    // stripped of the TypeScript a `load()` is allowed to return and the Loader is not.
    expect(prepared.modules[name]).toContain('positive: "#0a7d32"');
    expect(prepared.modules[name]).toStartWith("export default");
  });

  test("names the artifact by its own content, data and code alike", async () => {
    expect(prepared.artifact.id).toMatch(/^[0-9a-f]{32}$/);
    __resetForTests();
    const again = await prepare(fixtureRoot);
    expect(again.artifact.id).toBe(prepared.artifact.id);
  });

  test("shifts every path it names when the file map is not rooted at the project", async () => {
    __resetForTests();
    const shifted = await prepare(fixtureRoot, { pathPrefix: "some/where" });
    expect(Object.keys(shifted.artifact.generatedSources)).toContain(
      "some/where/node_modules/pletivo-vendor-demo/components/Badge.astro",
    );
    expect(shifted.artifact.vendor["pletivo-vendor-demo/components"]).toBe(
      "some/where/node_modules/pletivo-vendor-demo/components/index.ts",
    );
  });

  test("reports nothing it had to drop for this project", () => {
    expect(prepared.artifact.diagnostics).toEqual([]);
  });
});
