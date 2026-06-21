import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import path from "path";
import os from "os";
import fs from "fs/promises";
import { readdirSync } from "fs";
import {
  copyPublicAssets,
  hashPublicAssets,
} from "../../packages/pletivo/src/assets";
import { islandWrapperSource } from "../../packages/pletivo/src/islands-bundle";

describe("public asset copy/hash", () => {
  let pub: string;
  let dist: string;

  beforeEach(async () => {
    pub = await fs.mkdtemp(path.join(os.tmpdir(), "pletivo-pub-"));
    dist = await fs.mkdtemp(path.join(os.tmpdir(), "pletivo-dist-"));
    await fs.mkdir(path.join(pub, "nested"), { recursive: true });
    await fs.writeFile(path.join(pub, "logo.png"), "PNGDATA");
    await fs.writeFile(path.join(pub, "nested", "app.css"), "body{color:red}");
    await fs.writeFile(path.join(pub, "index.html"), "<html>");
  });

  afterEach(async () => {
    await fs.rm(pub, { recursive: true, force: true });
    await fs.rm(dist, { recursive: true, force: true });
  });

  describe("copyPublicAssets", () => {
    test("returns an empty manifest (rewriteRefs becomes a no-op)", async () => {
      const manifest = await copyPublicAssets(pub, dist);
      expect(manifest.size).toBe(0);
    });

    test("copies every file verbatim, preserving names and nested dirs", async () => {
      await copyPublicAssets(pub, dist);
      expect(readdirSync(dist).sort()).toEqual(["index.html", "logo.png", "nested"]);
      expect(readdirSync(path.join(dist, "nested"))).toEqual(["app.css"]);
      // Content is byte-identical, original filename retained (no content hash).
      expect(await Bun.file(path.join(dist, "logo.png")).text()).toBe("PNGDATA");
      expect(await Bun.file(path.join(dist, "nested", "app.css")).text()).toBe(
        "body{color:red}",
      );
    });

    test("returns an empty manifest and does not throw when publicDir is absent", async () => {
      const missing = path.join(pub, "does-not-exist");
      const manifest = await copyPublicAssets(missing, dist);
      expect(manifest.size).toBe(0);
      expect(readdirSync(dist)).toEqual([]);
    });
  });

  describe("hashPublicAssets", () => {
    test("hashes media + text assets and maps original → hashed in the manifest", async () => {
      const manifest = await hashPublicAssets(pub, dist);
      // logo.png (media) and nested/app.css (text) are hashed; index.html is not.
      expect(manifest.get("/logo.png")).toMatch(/^\/logo\.[0-9a-f]{8}\.png$/);
      expect(manifest.get("/nested/app.css")).toMatch(
        /^\/nested\/app\.[0-9a-f]{8}\.css$/,
      );
      expect(manifest.has("/index.html")).toBe(false);
    });

    test("copies non-hashable files (html) through with their original name", async () => {
      await hashPublicAssets(pub, dist);
      expect(await Bun.file(path.join(dist, "index.html")).text()).toBe("<html>");
    });

    test("returns an empty manifest when publicDir is absent", async () => {
      const manifest = await hashPublicAssets(path.join(pub, "nope"), dist);
      expect(manifest.size).toBe(0);
    });
  });
});

describe("islandWrapperSource", () => {
  test("hydrates existing SSR markup but renders fresh when empty", () => {
    const src = islandWrapperSource("/abs/path/Counter.tsx");
    // Imports both hydrate and render from preact.
    expect(src).toContain(`import { hydrate, render, h } from "preact";`);
    expect(src).toContain(`import Component from "/abs/path/Counter.tsx";`);
    // Branches on firstElementChild (not firstChild) so a leading comment /
    // whitespace SSR node doesn't force the crashing hydrate path.
    expect(src).toContain("el.firstElementChild");
    expect(src).not.toContain("el.firstChild");
    expect(src).toContain("hydrate(h(Component, props), el)");
    expect(src).toContain("render(h(Component, props), el)");
  });
});
