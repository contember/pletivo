import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import path from "path";
import fs from "fs/promises";
import { build } from "../../packages/pletivo/src/build";
import {
  resolveImageServiceConfig,
  type PletivoConfig,
} from "../../packages/pletivo/src/config";
import {
  readImageDimensions,
  getImage,
  setImageMode,
  setImageService,
  clearTransforms,
  getTransforms,
  processImages,
} from "../../packages/pletivo/src/image";
import { setBase } from "../../packages/pletivo/src/base";

const fixtureRoot = path.join(import.meta.dir, "../fixture-image");
const distDir = path.join(fixtureRoot, "dist");

const config: PletivoConfig = {
  host: "localhost",
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
    setBase("/");
    setImageMode("build");
    setImageService("sharp");
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
    setBase("/my-site");
    clearTransforms();
    const result = await getImage({
      src: { src: "/_astro/photo.abc.jpg", width: 100, height: 100, format: "jpeg", fsPath: "/tmp/photo.jpg" },
      alt: "photo",
    });
    expect(result.src).toStartWith("/my-site/_astro/");
    setBase("/");
  });

  test("passes through a public-root string src without registering a transform", async () => {
    clearTransforms();
    const result = await getImage({
      src: "/uploads/hero.jpg",
      width: 1200,
      height: 800,
      format: "webp",
      alt: "hero",
    });
    // Public assets are emitted + hashed separately (the rendered HTML is
    // rewritten against the public manifest). getImage must NOT route them
    // through the _astro/ pipeline — the sourcePath would be a
    // non-existent FS path and crash processImages().
    expect(result.src).toBe("/uploads/hero.jpg");
    expect(getTransforms().size).toBe(0);
  });

  test("passes through a remote URL string src without registering a transform", async () => {
    clearTransforms();
    const result = await getImage({
      src: "https://cdn.example.com/photo.jpg",
      width: 640,
      height: 480,
      alt: "remote",
    });
    expect(result.src).toBe("https://cdn.example.com/photo.jpg");
    expect(getTransforms().size).toBe(0);
  });
});

describe("getImage() image services", () => {
  beforeAll(() => {
    setBase("/");
    setImageMode("build");
    clearTransforms();
  });

  afterAll(() => {
    setImageService("sharp");
  });

  test("passthrough service emits the original URL and registers no transform", async () => {
    setImageService("passthrough");
    clearTransforms();
    const result = await getImage({
      src: { src: "/_astro/hero.abc123.jpg", width: 1920, height: 1080, format: "jpeg", fsPath: "/tmp/hero.jpg" },
      width: 800,
      alt: "hero",
    });
    expect(result.src).toBe("/_astro/hero.abc123.jpg");
    expect(getTransforms().size).toBe(0);
  });

  test("cloudflare service emits a /cdn-cgi/image URL and registers no sharp transform", async () => {
    setImageService("cloudflare");
    clearTransforms();
    const result = await getImage({
      src: { src: "/_astro/hero.abc123.jpg", width: 1920, height: 1080, format: "jpeg", fsPath: "/tmp/hero.jpg" },
      width: 800,
      alt: "hero",
    });
    expect(result.src).toStartWith("/cdn-cgi/image/");
    expect(result.src).toContain("onerror=redirect");
    expect(result.src).toContain("width=800");
    expect(result.src).toContain("/_astro/hero.abc123.jpg");
    expect(getTransforms().size).toBe(0);
  });

  test("cloudflare service builds a cdn-cgi srcset from responsive widths", async () => {
    setImageService("cloudflare");
    clearTransforms();
    const result = await getImage({
      src: { src: "/_astro/pic.def456.png", width: 2000, height: 1000, format: "png", fsPath: "/tmp/pic.png" },
      widths: [480, 960],
      sizes: "(min-width: 1024px) 50vw, 100vw",
      alt: "pic",
    });
    expect(result.srcSet.values.length).toBe(2);
    expect(result.srcSet.values[0].url).toStartWith("/cdn-cgi/image/");
    expect(result.srcSet.values[0].url).toContain("onerror=redirect");
    expect(result.srcSet.values[0].url).toContain("width=480");
    expect(result.srcSet.attribute).toContain("480w");
    expect(result.srcSet.attribute).toContain("960w");
    // `sizes` must reach the <img> so the srcset is actually usable.
    expect(result.attributes.sizes).toBe("(min-width: 1024px) 50vw, 100vw");
    expect(getTransforms().size).toBe(0);
  });

  test("cloudflare service leaves svg untouched (no cdn-cgi wrapping)", async () => {
    setImageService("cloudflare");
    clearTransforms();
    const result = await getImage({
      src: { src: "/_astro/icon.ghi789.svg", width: 24, height: 24, format: "svg", fsPath: "/tmp/icon.svg" },
      alt: "icon",
    });
    expect(result.src).not.toContain("/cdn-cgi/image/");
    expect(result.src).toContain(".svg");
  });

  test("bare string src still passes through unchanged", async () => {
    setImageService("cloudflare");
    clearTransforms();
    const result = await getImage({
      src: "/assets/photo.jpg",
      width: 600,
      height: 400,
      alt: "photo",
    });
    expect(result.src).toBe("/assets/photo.jpg");
    expect(getTransforms().size).toBe(0);
  });

  test("processImages copies originals byte-for-byte (no sharp re-encode)", async () => {
    const source = path.join(fixtureRoot, "src/assets/test.png");
    const tmpDist = path.join(import.meta.dir, "../.tmp-passthrough-copy");
    await fs.rm(tmpDist, { recursive: true, force: true });
    const registered = new Map([
      [
        "_astro/test.copy.png",
        {
          sourcePath: source,
          outputPath: "_astro/test.copy.png",
          format: "png",
          processing: "passthrough" as const,
        },
      ],
    ]);
    try {
      const count = await processImages(registered, tmpDist);
      expect(count).toBe(1);
      const out = new Uint8Array(await Bun.file(path.join(tmpDist, "_astro/test.copy.png")).arrayBuffer());
      const src = new Uint8Array(await Bun.file(source).arrayBuffer());
      // Byte-identical output means it was copied, not run through sharp.
      expect(out).toEqual(src);
    } finally {
      await fs.rm(tmpDist, { recursive: true, force: true });
    }
  });
});

describe("image service env default", () => {
  test("uses PLETIVO_IMAGE_SERVICE when config omits image.service", () => {
    expect(
      resolveImageServiceConfig(config, {
        PLETIVO_IMAGE_SERVICE: "passthrough",
      }),
    ).toBe("passthrough");
  });

  test("accepts cloudflare resize aliases", () => {
    expect(
      resolveImageServiceConfig(config, {
        PLETIVO_IMAGE_SERVICE: "cf-resize",
      }),
    ).toBe("cloudflare");
  });

  test("explicit config image.service wins over env default", () => {
    expect(
      resolveImageServiceConfig(
        { ...config, image: { service: "passthrough" } },
        { PLETIVO_IMAGE_SERVICE: "cloudflare" },
      ),
    ).toBe("passthrough");
  });

  test("rejects invalid env values", () => {
    expect(() =>
      resolveImageServiceConfig(config, {
        PLETIVO_IMAGE_SERVICE: "maybe",
      }),
    ).toThrow(/Invalid PLETIVO_IMAGE_SERVICE/);
  });
});

describe("processImages() resilience", () => {
  test("skips entries whose source file is missing instead of throwing", async () => {
    clearTransforms();
    const tmpDist = path.join(import.meta.dir, "../.tmp-procimg-resilience");
    await fs.rm(tmpDist, { recursive: true, force: true });
    const registered = new Map([
      [
        "_astro/missing.webp",
        {
          sourcePath: "/no/such/file-does-not-exist.jpg",
          outputPath: "_astro/missing.webp",
          format: "webp",
        },
      ],
    ]);
    let count = -1;
    try {
      count = await processImages(registered, tmpDist);
    } finally {
      await fs.rm(tmpDist, { recursive: true, force: true });
    }
    // Missing source is warned + skipped, not counted, and does not throw.
    expect(count).toBe(0);
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

  test("uppercase image extensions are loaded as image metadata", async () => {
    const html = await Bun.file(path.join(distDir, "index.html")).text();
    const match = html.match(
      /<script[^>]*id="uppercase-image-meta"[^>]*>(.*?)<\/script>/,
    );
    expect(match).not.toBeNull();
    const meta = JSON.parse(match![1]);
    expect(meta.width).toBe(4);
    expect(meta.height).toBe(4);
    expect(meta.src).toMatch(/\/_astro\/UPPER\.[a-f0-9]+\.JPG/);
    expect(meta.src).not.toContain(fixtureRoot);
  });

  test("image file is copied to dist/_astro/", async () => {
    const files = await fs.readdir(path.join(distDir, "_astro"));
    const imageFile = files.find(
      (f) => f.startsWith("test.") && f.endsWith(".png"),
    );
    expect(imageFile).toBeDefined();
    expect(files.some((f) => /^UPPER\.[a-f0-9]+\.JPG$/.test(f))).toBe(true);
  });
});
