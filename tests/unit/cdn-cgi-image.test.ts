import { describe, test, expect } from "bun:test";
import { createRequire } from "module";
import {
  parseCdnCgiImageUrl,
  buildCdnCgiImageUrl,
  parseCfImageOptions,
  resolveCfTargetFormat,
  formatFromPath,
  formatFromContentType,
  imageContentType,
  transformCfImage,
} from "../../packages/pletivo/src/image";

// Resolve sharp the same way image.ts does (relative to the package, not
// this test file) so the gate matches what `transformCfImage` actually
// uses. sharp is optional — the transform tests skip when it's absent.
const requireFromImage = createRequire(
  new URL("../../packages/pletivo/src/image.ts", import.meta.url),
);
let sharp: ((input?: unknown) => any) | null = null;
try {
  sharp = requireFromImage("sharp");
} catch {
  sharp = null;
}

describe("parseCdnCgiImageUrl", () => {
  test("splits options from a same-zone source path", () => {
    const parsed = parseCdnCgiImageUrl(
      "/cdn-cgi/image/quality=85,format=auto,width=1024/uploads/abc.jpg",
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.source).toBe("uploads/abc.jpg");
    expect(parsed!.options).toEqual({
      quality: 85,
      format: "auto",
      width: 1024,
    });
  });

  test("restores an absolute source URL collapsed to a single slash", () => {
    const parsed = parseCdnCgiImageUrl(
      "/cdn-cgi/image/width=200/https:/example.com/photo.png",
    );
    expect(parsed!.source).toBe("https://example.com/photo.png");
  });

  test("keeps an absolute source URL with both slashes intact", () => {
    const parsed = parseCdnCgiImageUrl(
      "/cdn-cgi/image/width=200/https://example.com/photo.png",
    );
    expect(parsed!.source).toBe("https://example.com/photo.png");
  });

  test("returns null for a non-cdn-cgi path", () => {
    expect(parseCdnCgiImageUrl("/uploads/abc.jpg")).toBeNull();
  });

  test("returns null when the source segment is missing", () => {
    expect(parseCdnCgiImageUrl("/cdn-cgi/image/width=100")).toBeNull();
  });
});

describe("buildCdnCgiImageUrl", () => {
  test("builds a same-zone url that round-trips through the parser", () => {
    const url = buildCdnCgiImageUrl("/_astro/hero.abc123.jpg", {
      width: 1024,
      quality: 85,
    });
    expect(url).toBe(
      "/cdn-cgi/image/width=1024,quality=85,format=auto/_astro/hero.abc123.jpg",
    );
    const parsed = parseCdnCgiImageUrl(url);
    expect(parsed!.source).toBe("_astro/hero.abc123.jpg");
    expect(parsed!.options).toEqual({ width: 1024, quality: 85, format: "auto" });
  });

  test("defaults format to auto and omits unset options", () => {
    expect(buildCdnCgiImageUrl("/assets/x.png", {})).toBe(
      "/cdn-cgi/image/format=auto/assets/x.png",
    );
  });

  test("keeps an absolute source url intact and round-trips it", () => {
    const url = buildCdnCgiImageUrl("https://cdn.example.com/p.jpg", {
      width: 200,
    });
    expect(url).toBe(
      "/cdn-cgi/image/width=200,format=auto/https://cdn.example.com/p.jpg",
    );
    expect(parseCdnCgiImageUrl(url)!.source).toBe("https://cdn.example.com/p.jpg");
  });

  test("honors an explicit format and fit", () => {
    expect(
      buildCdnCgiImageUrl("/a.jpg", { width: 100, format: "webp", fit: "cover" }),
    ).toBe("/cdn-cgi/image/width=100,format=webp,fit=cover/a.jpg");
  });
});

describe("parseCfImageOptions", () => {
  test("parses the common option set with aliases", () => {
    expect(parseCfImageOptions("w=300,h=200,q=70,fit=cover,g=auto,dpr=2")).toEqual({
      width: 300,
      height: 200,
      quality: 70,
      fit: "cover",
      gravity: "auto",
      dpr: 2,
    });
  });

  test("maps named qualities and clamps numeric quality", () => {
    expect(parseCfImageOptions("quality=high").quality).toBe(90);
    expect(parseCfImageOptions("quality=low").quality).toBe(35);
    expect(parseCfImageOptions("quality=999").quality).toBe(100);
    expect(parseCfImageOptions("quality=0").quality).toBe(1);
  });

  test("ignores unknown options and malformed pairs", () => {
    expect(parseCfImageOptions("anim=false,trim=10,width=50,bogus")).toEqual({
      width: 50,
    });
  });

  test("decodes a url-encoded background colour", () => {
    expect(parseCfImageOptions("background=%23ffffff").background).toBe("#ffffff");
  });
});

describe("resolveCfTargetFormat", () => {
  test("auto picks webp when the client accepts it", () => {
    expect(resolveCfTargetFormat("auto", "png", "image/avif,image/webp,*/*")).toBe(
      "webp",
    );
  });

  test("auto keeps the source format without webp support", () => {
    expect(resolveCfTargetFormat("auto", "jpeg", "*/*")).toBe("jpeg");
    expect(resolveCfTargetFormat(undefined, "png", undefined)).toBe("png");
  });

  test("an explicit format always wins", () => {
    expect(resolveCfTargetFormat("avif", "png", "*/*")).toBe("avif");
  });
});

describe("format helpers", () => {
  test("formatFromPath normalizes jpg→jpeg and strips query/hash", () => {
    expect(formatFromPath("/a/b.JPG?v=1")).toBe("jpeg");
    expect(formatFromPath("x.webp#frag")).toBe("webp");
    expect(formatFromPath("/no/extension")).toBe("jpeg");
  });

  test("formatFromContentType maps image mime types", () => {
    expect(formatFromContentType("image/png; charset=binary")).toBe("png");
    expect(formatFromContentType("text/html")).toBeNull();
    expect(formatFromContentType(null)).toBeNull();
  });

  test("imageContentType maps formats and falls back", () => {
    expect(imageContentType("webp")).toBe("image/webp");
    expect(imageContentType("jpg")).toBe("image/jpeg");
    expect(imageContentType("mystery")).toBe("application/octet-stream");
  });
});

// The actual pixel transform needs sharp. Gate on its availability so CI
// without the native binary still runs the rest of the suite.
describe.skipIf(!sharp)("transformCfImage (sharp)", () => {
  async function makeSource(width: number, height: number): Promise<Uint8Array> {
    const buf = await sharp!({
      create: {
        width,
        height,
        channels: 3,
        background: { r: 200, g: 80, b: 40 },
      },
    })
      .png()
      .toBuffer();
    return new Uint8Array(buf);
  }

  async function dimensions(
    data: Uint8Array,
  ): Promise<{ width: number; height: number; format: string }> {
    const meta = await sharp!(data).metadata();
    return { width: meta.width, height: meta.height, format: meta.format };
  }

  test("resizes preserving aspect ratio and converts to webp", async () => {
    const src = await makeSource(200, 120);
    const out = await transformCfImage(
      src,
      "png",
      { width: 40, format: "auto", quality: 85 },
      "image/webp",
    );
    expect(out).not.toBeNull();
    expect(out!.contentType).toBe("image/webp");
    const dims = await dimensions(out!.data);
    expect(dims.format).toBe("webp");
    expect(dims.width).toBe(40);
    expect(dims.height).toBe(24);
  });

  test("fit=cover crops to exact box", async () => {
    const src = await makeSource(200, 120);
    const out = await transformCfImage(src, "png", {
      width: 80,
      height: 80,
      fit: "cover",
      format: "png",
    });
    const dims = await dimensions(out!.data);
    expect(dims.width).toBe(80);
    expect(dims.height).toBe(80);
  });

  test("dpr multiplies the requested dimensions", async () => {
    const src = await makeSource(200, 120);
    const out = await transformCfImage(src, "png", {
      width: 30,
      dpr: 2,
      format: "png",
    });
    const dims = await dimensions(out!.data);
    expect(dims.width).toBe(60);
  });

  test("scale-down (default fit) never enlarges past the source", async () => {
    const src = await makeSource(50, 50);
    const out = await transformCfImage(src, "png", { width: 500, format: "png" });
    const dims = await dimensions(out!.data);
    expect(dims.width).toBe(50);
  });

  test("returns null for SVG sources (served untouched)", async () => {
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>',
    );
    expect(await transformCfImage(svg, "svg", { width: 5 })).toBeNull();
  });
});
