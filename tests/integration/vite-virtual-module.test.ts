import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import path from "path";
import fs from "fs/promises";
import { build } from "../../packages/pletivo/src/build";
import { __resetForTests } from "../../packages/pletivo/src/astro-host/runner";
import type { PletivoConfig } from "../../packages/pletivo/src/config";

const fixtureRoot = path.join(import.meta.dir, "../fixture-vite-virtual-module");
const distDir = path.join(fixtureRoot, "dist");

const config: PletivoConfig = {
  host: "localhost",
  outDir: "dist",
  port: 3000,
  base: "/",
  srcDir: "src",
  publicDir: "public",
};

describe("Vite virtual modules from Astro integrations", () => {
  beforeAll(async () => {
    __resetForTests();
    await build(fixtureRoot, config);
  });

  afterAll(async () => {
    __resetForTests();
    await fs.rm(distDir, { recursive: true, force: true });
  });

  test("renders virtual imports used by .astro components", async () => {
    const html = await Bun.file(path.join(distDir, "index.html")).text();
    expect(html).toContain("hello from virtual");
  });
});
