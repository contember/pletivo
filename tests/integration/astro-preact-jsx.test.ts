import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import path from "path";
import fs from "fs/promises";
import { build } from "../../packages/pletivo/src/build";
import { __resetForTests } from "../../packages/pletivo/src/astro-host/runner";
import type { PletivoConfig } from "../../packages/pletivo/src/config";

// The fixture's tsconfig names no JSX runtime, so without the integration Bun
// would compile for React, which is not installed.
const fixtureRoot = path.join(import.meta.dir, "../fixture-astro-preact-jsx");
const distDir = path.join(fixtureRoot, "dist");

const config: PletivoConfig = {
  host: "localhost",
  outDir: "dist",
  port: 3000,
  base: "/",
  srcDir: "src",
  publicDir: "public",
};

describe("@astrojs/preact picks the JSX runtime of project modules", () => {
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

  test("a .jsx module creates Preact elements", () => {
    expect(html).toContain('<p id="jsx">true</p>');
  });

  test("a .tsx module creates Preact elements", () => {
    expect(html).toContain('<p id="tsx">true</p>');
  });
});
