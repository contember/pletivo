import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import path from "path";
import fs from "fs/promises";
import { build } from "../../src/build";
import type { PavoukConfig } from "../../src/config";

const fixtureRoot = path.join(import.meta.dir, "../fixture");
const distDir = path.join(fixtureRoot, "dist");

const config: PavoukConfig = {
  outDir: "dist",
  port: 3000,
  base: "/",
  srcDir: "src",
  publicDir: "public",
};

describe("build", () => {
  beforeAll(async () => {
    await build(fixtureRoot, config);
  });

  afterAll(async () => {
    await fs.rm(distDir, { recursive: true, force: true });
  });

  test("creates dist directory", async () => {
    const stat = await fs.stat(distDir);
    expect(stat.isDirectory()).toBe(true);
  });

  test("generates index.html", async () => {
    const content = await Bun.file(path.join(distDir, "index.html")).text();
    expect(content).toContain("<!DOCTYPE html>");
    expect(content).toContain("<h1>Home Page</h1>");
  });

  test("generates about page", async () => {
    const content = await Bun.file(path.join(distDir, "about/index.html")).text();
    expect(content).toContain("<h1>About Page</h1>");
  });

  test("generates blog index", async () => {
    const content = await Bun.file(path.join(distDir, "blog/index.html")).text();
    expect(content).toContain("<h1>Blog</h1>");
    expect(content).toContain("First Post");
    expect(content).toContain("Second Post");
  });

  test("generates dynamic blog post pages", async () => {
    const post1 = await Bun.file(path.join(distDir, "blog/post-one/index.html")).text();
    expect(post1).toContain("<h1>First Post</h1>");
    expect(post1).toContain("<strong>first</strong>");

    const post2 = await Bun.file(path.join(distDir, "blog/post-two/index.html")).text();
    expect(post2).toContain("<h1>Second Post</h1>");
  });

  test("island has SSR content", async () => {
    const content = await Bun.file(path.join(distDir, "index.html")).text();
    expect(content).toContain("<pavouk-island");
    expect(content).toContain('data-component="Counter"');
    expect(content).toContain('data-hydrate="load"');
    expect(content).toContain("<button>Count: 5</button>");
  });

  test("hydration script is injected on pages with islands", async () => {
    const content = await Bun.file(path.join(distDir, "index.html")).text();
    expect(content).toContain("pavouk-island");
    expect(content).toContain("/_islands/");
  });

  test("hydration script is NOT injected on pages without islands", async () => {
    const content = await Bun.file(path.join(distDir, "about/index.html")).text();
    expect(content).not.toContain("/_islands/");
  });

  test("island bundle is generated", async () => {
    const bundle = await Bun.file(path.join(distDir, "_islands/Counter.js")).text();
    expect(bundle).toContain("mount");
  });

  test("island bundle does not contain server JSX runtime", async () => {
    const bundle = await Bun.file(path.join(distDir, "_islands/Counter.js")).text();
    // Should not contain the full JSX runtime (void elements list, renderAttrs, etc.)
    expect(bundle).not.toContain("VOID_ELEMENTS");
    expect(bundle).not.toContain("renderAttrs");
  });

  test("public files are copied to dist", async () => {
    const css = await Bun.file(path.join(distDir, "style.css")).text();
    expect(css).toContain("font-family");
  });

  test("generates custom 404 page", async () => {
    const content = await Bun.file(path.join(distDir, "404.html")).text();
    expect(content).toContain("404 - Page Not Found");
  });

  test("all pages have DOCTYPE", async () => {
    const files = [
      "index.html",
      "about/index.html",
      "blog/index.html",
      "blog/post-one/index.html",
    ];
    for (const file of files) {
      const content = await Bun.file(path.join(distDir, file)).text();
      expect(content).toStartWith("<!DOCTYPE html>");
    }
  });
});
