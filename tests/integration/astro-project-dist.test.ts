import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import path from "path";
import fs from "fs/promises";
import { readdirSync } from "fs";
import { build } from "../../packages/pletivo/src/build";
import { __resetForTests } from "../../packages/pletivo/src/astro-host/runner";
import type { PletivoConfig } from "../../packages/pletivo/src/config";

// An Astro project's dist/ holds what Astro would emit: public/ verbatim and
// no sitemap unless an integration writes one.
const fixtureRoot = path.join(import.meta.dir, "../fixture-astro-public");

const config: PletivoConfig = {
  host: "localhost",
  outDir: "dist",
  port: 3000,
  base: "/",
  srcDir: "src",
  publicDir: "public",
};

describe("Astro project dist/", () => {
  const distDir = path.join(fixtureRoot, "dist");

  beforeAll(async () => {
    __resetForTests();
    await build(fixtureRoot, config);
  });

  afterAll(async () => {
    __resetForTests();
    await fs.rm(distDir, { recursive: true, force: true });
  });

  test("copies public/ under its own names", async () => {
    const files = readdirSync(distDir);
    expect(files).toContain("favicon.svg");
    expect(files.some((f) => /^favicon\.[0-9a-f]{8}\.svg$/.test(f))).toBe(false);
    const html = await Bun.file(path.join(distDir, "index.html")).text();
    expect(html).toContain('href="/favicon.svg"');
  });

  test("writes no sitemap of its own", () => {
    expect(readdirSync(distDir)).not.toContain("sitemap.xml");
  });
});

describe("Astro project with hashAssets: true", () => {
  const distDir = path.join(fixtureRoot, "dist-hashed");

  beforeAll(async () => {
    __resetForTests();
    await build(fixtureRoot, { ...config, outDir: "dist-hashed", hashAssets: true });
  });

  afterAll(async () => {
    __resetForTests();
    await fs.rm(distDir, { recursive: true, force: true });
  });

  test("hashes public/ and rewrites the reference", async () => {
    const hashed = readdirSync(distDir).find((f) => /^favicon\.[0-9a-f]{8}\.svg$/.test(f));
    expect(hashed).toBeDefined();
    const html = await Bun.file(path.join(distDir, "index.html")).text();
    expect(html).toContain(`href="/${hashed}"`);
  });
});
