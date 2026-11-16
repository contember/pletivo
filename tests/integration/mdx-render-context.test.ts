import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import path from "path";
import fs from "fs/promises";
import { build } from "../../packages/pletivo/src/build";
import { __resetForTests } from "../../packages/pletivo/src/astro-host/runner";
import type { PletivoConfig } from "../../packages/pletivo/src/config";

const fixtureRoot = path.join(import.meta.dir, "../fixture-mdx-render-context");
const distDir = path.join(fixtureRoot, "dist");

const config: PletivoConfig = {
  host: "localhost",
  outDir: "dist",
  port: 3000,
  base: "/",
  srcDir: "src",
  publicDir: "public",
};

describe("an .astro component inside MDX content rendered by a page", () => {
  let html: string;

  beforeAll(async () => {
    __resetForTests();
    await build(fixtureRoot, config);
    html = await Bun.file(path.join(distDir, "docs/intro/index.html")).text();
  });

  afterAll(async () => {
    __resetForTests();
    await fs.rm(distDir, { recursive: true, force: true });
  });

  test("renders inside the page's request: Astro.url and Astro.locals are the page's", () => {
    expect(html).toContain("path /docs/intro/, locals set by the page");
  });
});
