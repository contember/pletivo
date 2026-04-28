import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import path from "path";
import fs from "fs/promises";
import { build } from "../../packages/pletivo/src/build";
import { __resetForTests } from "../../packages/pletivo/src/astro-host/runner";
import type { PletivoConfig } from "../../packages/pletivo/src/config";

const fixtureRoot = path.join(import.meta.dir, "../fixture-astro-scripts");
const distDir = path.join(fixtureRoot, "dist");

const config: PletivoConfig = {
  outDir: "dist",
  port: 3000,
  base: "/",
  srcDir: "src",
  publicDir: "public",
};

describe("astro <script> blocks (TypeScript stripped)", () => {
  let html: string;

  beforeAll(async () => {
    __resetForTests();
    await build(fixtureRoot, config);
    html = await Bun.file(path.join(distDir, "index.html")).text();
  });

  afterAll(async () => {
    __resetForTests();
    await fs.rm(distDir, { recursive: true, force: true });
  });

  describe("hoisted <script>", () => {
    test("strips `private` modifier and type annotations", () => {
      expect(html).not.toMatch(/\bprivate\s+\w+/);
      expect(html).not.toMatch(/:\s*Item\[\]/);
    });

    test("strips `type` declarations", () => {
      expect(html).not.toMatch(/^\s*type\s+Item\s*=/m);
    });

    test("strips `as` type assertions", () => {
      expect(html).not.toMatch(/\bas\s+HTMLButtonElement\b/);
    });

    test("strips parameter type annotations", () => {
      expect(html).not.toMatch(/\(\s*e\s*:\s*MouseEvent\s*\)/);
    });

    test("strips generic type arguments", () => {
      expect(html).not.toContain("Set<string>");
    });

    test("preserves runtime identifiers and behavior", () => {
      expect(html).toContain("fieldInteractions");
      expect(html).toContain("HoistedWidget");
      expect(html).toContain("customElements.define");
      expect(html).toContain("hoisted-widget");
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
