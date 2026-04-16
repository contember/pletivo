import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import path from "path";
import fs from "fs/promises";
import { build } from "../../packages/pletivo/src/build";
import type { PletivoConfig } from "../../packages/pletivo/src/config";

const fixtureRoot = path.join(import.meta.dir, "../fixture-astro-styles");
const distDir = path.join(fixtureRoot, "dist");

const config: PletivoConfig = {
  outDir: "dist",
  port: 3000,
  base: "/",
  srcDir: "src",
  publicDir: "public",
};

describe("scoped styles", () => {
  beforeAll(async () => {
    await build(fixtureRoot, config);
  });

  afterAll(async () => {
    await fs.rm(distDir, { recursive: true, force: true });
  });

  test("index page contains scoped CSS from Layout and Card", async () => {
    const html = await Bun.file(path.join(distDir, "index.html")).text();
    // Layout's scoped style: body { margin: 0; ... }
    expect(html).toContain("margin:0");
    // Card's scoped style: .card { padding: 1rem; ... }
    expect(html).toContain("padding:1rem");
    // Scoped CSS uses :where(.astro-XXXXX) selectors
    expect(html).toMatch(/astro-[a-z0-9]+/);
    // Styles should be in a <style> tag
    expect(html).toMatch(/<style>.*astro-[a-z0-9]+.*<\/style>/s);
  });

  test("index page has scoped class attributes on elements", async () => {
    const html = await Bun.file(path.join(distDir, "index.html")).text();
    // Elements should have astro scope classes
    expect(html).toMatch(/class="[^"]*astro-[a-z0-9]+/);
  });

  test("standalone page has its own scoped styles", async () => {
    const html = await Bun.file(
      path.join(distDir, "standalone/index.html"),
    ).text();
    // Should contain the .hero scoped style
    expect(html).toContain("font-size:3rem");
    expect(html).toContain("rebeccapurple");
  });

  test("standalone page does NOT contain Card styles", async () => {
    const html = await Bun.file(
      path.join(distDir, "standalone/index.html"),
    ).text();
    // Card's scoped CSS should not leak into standalone page
    expect(html).not.toContain("border-radius:8px");
  });

  test("scoped styles are inside <head>", async () => {
    const html = await Bun.file(path.join(distDir, "index.html")).text();
    const headEnd = html.indexOf("</head>");
    const styleStart = html.indexOf("<style>");
    // Style tag should appear before </head>
    expect(styleStart).toBeGreaterThan(-1);
    expect(headEnd).toBeGreaterThan(styleStart);
  });

  test("page without <head> still gets scoped styles", async () => {
    const html = await Bun.file(
      path.join(distDir, "no-head/index.html"),
    ).text();
    expect(html).toContain("background:salmon");
    expect(html).toContain("padding:2rem");
  });
});
