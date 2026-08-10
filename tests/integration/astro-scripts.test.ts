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
    // Hoisted <script> blocks now bundle into /_astro/hoisted-<hash>.js
    // and are referenced from the page via <script src="…">. Locate the
    // emitted bundle by its hash (extracted from the page) and read it.
    const m = html.match(/\/_astro\/hoisted-([a-f0-9]+)\.js/);
    expect(m).not.toBeNull();
    hoistedJs = await Bun.file(path.join(distDir, "_astro", `hoisted-${m![1]}.js`)).text();
  });

  afterAll(async () => {
    __resetForTests();
    await fs.rm(distDir, { recursive: true, force: true });
  });

  describe("hoisted <script>", () => {
    test("page references the bundled script via src=, not inline", () => {
      expect(html).toMatch(/<script type="module" src="\/_astro\/hoisted-[a-f0-9]+\.js"><\/script>/);
      expect(html).not.toContain("HoistedWidget");
      expect(html).not.toContain("fieldInteractions");
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
      expect(html).not.toMatch(/injectedPageValue\s*:\s*number/);
      expect(html).toContain("injectedPageValue");
      expect(html).toContain("42");
    });

    test("strips TS from `head-inline` stage", () => {
      expect(html).not.toMatch(/injectedHeadValue\s*:\s*string/);
      expect(html).toContain("injectedHeadValue");
      expect(html).toContain("head-ok");
    });
  });
});
