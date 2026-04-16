import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import path from "path";
import fs from "fs/promises";
import { build } from "../../packages/pletivo/src/build";
import type { PletivoConfig } from "../../packages/pletivo/src/config";
import {
  readImageDimensions,
  getImage,
  setImageMode,
  clearTransforms,
  getTransforms,
} from "../../packages/pletivo/src/image";

const fixtureRoot = path.join(import.meta.dir, "../fixture-image");
const distDir = path.join(fixtureRoot, "dist");

const config: PletivoConfig = {
  outDir: "dist",
  port: 3000,
  base: "/",
  srcDir: "src",
  publicDir: "public",
};

describe("image dimension reader", () => {
  test("reads PNG dimensions", async () => {
    const dims = await readImageDimensions(
      path.join(fixtureRoot, "src/assets/test.png"),
    );
    expect(dims.width).toBe(4);
    expect(dims.height).toBe(4);
    expect(dims.format).toBe("png");
  });
});

describe("getImage()", () => {
  beforeAll(() => {
    setImageMode("build", "/");
    clearTransforms();
  });

  test("computes dimensions from metadata", async () => {
    const result = await getImage({
      src: { src: "/_astro/test.abc.png", width: 400, height: 200, format: "png", fsPath: "/tmp/test.png" },
      width: 200,
      alt: "test",
    });
    expect(result.attributes.width).toBe(200);
    expect(result.attributes.height).toBe(100); // aspect ratio preserved
    expect(result.attributes.loading).toBe("lazy");
    expect(result.attributes.decoding).toBe("async");
    expect(result.attributes.alt).toBe("test");
  });

  test("defaults to webp format", async () => {
    const result = await getImage({
      src: { src: "/_astro/test.abc.png", width: 100, height: 100, format: "png", fsPath: "/tmp/test.png" },
      alt: "test",
    });
    expect(result.src).toContain(".webp");
  });

  test("preserves svg format", async () => {
    const result = await getImage({
      src: { src: "/_astro/icon.abc.svg", width: 24, height: 24, format: "svg", fsPath: "/tmp/icon.svg" },
      alt: "icon",
    });
    expect(result.src).toContain(".svg");
    expect(result.src).not.toContain(".webp");
  });

  test("registers transform in build mode", async () => {
    clearTransforms();
    await getImage({
      src: { src: "/_astro/hero.abc.png", width: 1920, height: 1080, format: "png", fsPath: "/tmp/hero.png" },
      width: 800,
      alt: "hero",
    });
    const transforms = getTransforms();
    expect(transforms.size).toBe(1);
    const entry = [...transforms.values()][0];
    expect(entry.width).toBe(800);
    expect(entry.format).toBe("webp");
    expect(entry.sourcePath).toBe("/tmp/hero.png");
  });

  test("output path includes base", async () => {
    setImageMode("build", "/my-site");
    clearTransforms();
    const result = await getImage({
      src: { src: "/_astro/photo.abc.jpg", width: 100, height: 100, format: "jpeg", fsPath: "/tmp/photo.jpg" },
      alt: "photo",
    });
    expect(result.src).toStartWith("/my-site/_astro/");
    setImageMode("build", "/");
  });
});

describe("image build integration", () => {
  beforeAll(async () => {
    await build(fixtureRoot, config);
  });

  afterAll(async () => {
    await fs.rm(distDir, { recursive: true, force: true });
  });

  test("page renders with image metadata", async () => {
    const html = await Bun.file(path.join(distDir, "index.html")).text();
    expect(html).toContain("<img");
    expect(html).toContain('width="4"');
    expect(html).toContain('height="4"');
    expect(html).toContain("/_astro/test.");
  });

  test("image metadata JSON is embedded", async () => {
    const html = await Bun.file(path.join(distDir, "index.html")).text();
    const match = html.match(
      /<script[^>]*id="image-meta"[^>]*>(.*?)<\/script>/,
    );
    expect(match).not.toBeNull();
    const meta = JSON.parse(match![1]);
    expect(meta.width).toBe(4);
    expect(meta.height).toBe(4);
    expect(meta.format).toBe("png");
    expect(meta.src).toMatch(/\/_astro\/test\.[a-f0-9]+\.png/);
  });

  test("image file is copied to dist/_astro/", async () => {
    const files = await fs.readdir(path.join(distDir, "_astro"));
    const imageFile = files.find(
      (f) => f.startsWith("test.") && f.endsWith(".png"),
    );
    expect(imageFile).toBeDefined();
  });
});
