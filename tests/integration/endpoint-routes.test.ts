import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import path from "path";
import fs from "fs/promises";
import { build } from "../../packages/pletivo/src/build";
import { __resetForTests } from "../../packages/pletivo/src/astro-host/runner";
import type { PletivoConfig } from "../../packages/pletivo/src/config";

const fixtureRoot = path.join(import.meta.dir, "../fixture-endpoint-routes");
const distDir = path.join(fixtureRoot, "dist");

const config: PletivoConfig = {
  host: "localhost",
  outDir: "dist",
  port: 3000,
  base: "/",
  srcDir: "src",
  publicDir: "public",
};

async function exists(rel: string): Promise<boolean> {
  try {
    await fs.access(path.join(distDir, rel));
    return true;
  } catch {
    return false;
  }
}

describe("endpoint routes in src/pages", () => {
  beforeAll(async () => {
    __resetForTests();
    await build(fixtureRoot, config);
  });

  afterAll(async () => {
    __resetForTests();
    await fs.rm(distDir, { recursive: true, force: true });
  });

  test("ordinary pages still render", async () => {
    const content = await Bun.file(path.join(distDir, "index.html")).text();
    expect(content).toContain("<h1");
    expect(content).toContain("Home Page");
  });

  test("text endpoint is emitted at its own path", async () => {
    const content = await Bun.file(path.join(distDir, "robots.txt")).text();
    expect(content).toBe("User-agent: *\nAllow: /\n");
  });

  test("endpoint does not produce an index.html directory", async () => {
    expect(await exists("robots.txt/index.html")).toBe(false);
    expect(await exists("data.json/index.html")).toBe(false);
  });

  test("JSON endpoint output is byte-exact and parseable", async () => {
    const raw = await Bun.file(path.join(distDir, "data.json")).text();
    // The regression this guards: writeHtml prepends the page <style> block to
    // any output without a </head>, which would make the JSON unparseable.
    expect(raw.trimStart().startsWith("{")).toBe(true);
    expect(raw).not.toContain("<style>");
    expect(raw).not.toContain("<link rel=\"stylesheet\"");
    const parsed = JSON.parse(raw);
    expect(parsed.items).toEqual([1, 2, 3]);
  });

  test("endpoints receive the site context", async () => {
    const parsed = JSON.parse(await Bun.file(path.join(distDir, "data.json")).text());
    expect(parsed.site).toBe("https://example.com/");
  });

  test("XML endpoint keeps its declaration on the first byte", async () => {
    const raw = await Bun.file(path.join(distDir, "feed.xml")).text();
    expect(raw.startsWith("<?xml")).toBe(true);
    expect(raw).not.toContain("<style>");
  });
});
