import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import path from "path";
import fs from "fs/promises";
import { build } from "../../packages/pletivo/src/build";
import { __resetForTests } from "../../packages/pletivo/src/astro-host/runner";
import type { PletivoConfig } from "../../packages/pletivo/src/config";

const fixtureRoot = path.join(import.meta.dir, "../fixture-astro-scripts");
const distDir = path.join(fixtureRoot, "dist");

const config: PletivoConfig = {
  host: "localhost",
  outDir: "dist",
  port: 3000,
  base: "/",
  srcDir: "src",
  publicDir: "public",
};

describe("astro <script> blocks (TypeScript stripped)", () => {
  let html: string;
  let hoistedJs: string;

  beforeAll(async () => {
    __resetForTests();
    await build(fixtureRoot, config);
    html = await Bun.file(path.join(distDir, "index.html")).text();
    // The hoisted <script> bundles to under 4096 B and imports nothing, so,
    // as in Astro, the page carries the bundle inline rather than linking it.
    const inline = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)]
      .map((m) => m[1])
      .filter((code) => code.includes("hoisted-widget"));
    expect(inline).toHaveLength(1);
    hoistedJs = inline[0];
  });

  afterAll(async () => {
    __resetForTests();
    await fs.rm(distDir, { recursive: true, force: true });
  });

  describe("hoisted <script>", () => {
    test("page inlines the bundled script, not its source", () => {
      expect(html).not.toMatch(/<script type="module" src="\/_astro\/hoisted-/);
      expect(html).not.toContain("class HoistedWidget");
    });

    test("strips `private` modifier and type annotations", () => {
      expect(hoistedJs).not.toMatch(/\bprivate\s+\w+/);
      expect(hoistedJs).not.toMatch(/:\s*Item\[\]/);
    });

    test("strips `type` declarations", () => {
      expect(hoistedJs).not.toMatch(/^\s*type\s+Item\s*=/m);
    });

    test("strips `as` type assertions", () => {
      expect(hoistedJs).not.toMatch(/\bas\s+HTMLButtonElement\b/);
    });

    test("strips parameter type annotations", () => {
      expect(hoistedJs).not.toMatch(/\(\s*e\s*:\s*MouseEvent\s*\)/);
    });

    test("strips generic type arguments", () => {
      expect(hoistedJs).not.toContain("Set<string>");
    });

    test("preserves runtime identifiers and behavior", () => {
      // Bun.build minifies, so identifiers may be mangled. Check for the
      // string literals and API calls that survive minification verbatim.
      expect(hoistedJs).toContain("customElements.define");
      expect(hoistedJs).toContain("hoisted-widget");
      expect(hoistedJs).toContain("hoisted-btn");
    });
  });

  describe("integration injectScript", () => {
    test("strips TS from `page` stage", () => {
      // Bundled and minified, so the local name is gone; what it did is not.
      expect(html).not.toMatch(/injectedPageValue\s*:\s*number/);
      expect(html).toMatch(/dataset\.injectedPage\s*=\s*String\(42\)/);
    });

    test("strips TS from `head-inline` stage", () => {
      expect(html).not.toMatch(/injectedHeadValue\s*:\s*string/);
      expect(html).toContain("injectedHeadValue");
      expect(html).toContain("head-ok");
    });
  });
});
