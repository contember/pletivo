import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import path from "path";
import fs from "fs/promises";
import { build } from "../../packages/pletivo/src/build";
import { __resetForTests } from "../../packages/pletivo/src/astro-host/runner";
import type { PletivoConfig } from "../../packages/pletivo/src/config";

const fixtureRoot = path.join(import.meta.dir, "../fixture-inject-route");
const distDir = path.join(fixtureRoot, "dist");

const config: PletivoConfig = {
  outDir: "dist",
  port: 3000,
  base: "/",
  srcDir: "src",
  publicDir: "public",
};

describe("injectRoute", () => {
  beforeAll(async () => {
    __resetForTests();
    await build(fixtureRoot, config);
  });

  afterAll(async () => {
    __resetForTests();
    await fs.rm(distDir, { recursive: true, force: true });
  });

  test("normal page still renders", async () => {
    const content = await Bun.file(path.join(distDir, "index.html")).text();
    expect(content).toContain("<h1>Home Page</h1>");
  });

  test("injected robots.txt endpoint is rendered", async () => {
    const content = await Bun.file(path.join(distDir, "robots.txt")).text();
    expect(content).toContain("User-agent: *");
    expect(content).toContain("Allow: /");
    expect(content).toContain("Sitemap: https://example.com/sitemap.xml");
  });

  test("injected feed.xml endpoint is rendered", async () => {
    const content = await Bun.file(path.join(distDir, "feed.xml")).text();
    expect(content).toContain('<?xml version="1.0"');
    expect(content).toContain("<rss");
    expect(content).toContain("<title>Test Feed</title>");
    expect(content).toContain("https://example.com/blog/first");
  });

  test("injected routes receive site context", async () => {
    const content = await Bun.file(path.join(distDir, "feed.xml")).text();
    // The feed.xml endpoint uses the site URL from context
    expect(content).toContain("https://example.com");
  });
});
