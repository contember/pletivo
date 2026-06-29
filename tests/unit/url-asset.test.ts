import { describe, test, expect, beforeEach } from "bun:test";
import path from "path";
import {
  setUrlAssetMode,
  registerUrlAsset,
  getUrlAssets,
  clearUrlAssets,
} from "../../packages/pletivo/src/url-asset";
import { setBase } from "../../packages/pletivo/src/base";

// Any real file works — build mode reads + content-hashes it.
const fixture = path.join(import.meta.dir, "../fixture-image/src/assets/test.png");

describe("?url asset resolution", () => {
  beforeEach(() => {
    setBase("/");
    clearUrlAssets();
  });

  test("dev mode serves the original file from /@asset/", async () => {
    setUrlAssetMode("dev");
    const href = await registerUrlAsset(fixture);
    expect(href).toBe(`/@asset/test.png?f=${fixture}`);
    // Dev serves on the fly — nothing is registered for build emission.
    expect(getUrlAssets().size).toBe(0);
  });

  test("build mode content-hashes under _astro/ and records for emission", async () => {
    setUrlAssetMode("build");
    const href = await registerUrlAsset(fixture);
    expect(href).toMatch(/^\/_astro\/test\.[0-9a-f]{8}\.png$/);
    const assets = getUrlAssets();
    expect(assets.size).toBe(1);
    expect(assets.get(href.slice(1))).toBe(fixture); // key is outputPath (no leading slash)
  });

  test("build hash is stable for identical content", async () => {
    setUrlAssetMode("build");
    const a = await registerUrlAsset(fixture);
    const b = await registerUrlAsset(fixture);
    expect(a).toBe(b);
  });

  test("respects the configured base path", async () => {
    setBase("/app");
    setUrlAssetMode("build");
    const href = await registerUrlAsset(fixture);
    expect(href).toMatch(/^\/app\/_astro\/test\.[0-9a-f]{8}\.png$/);
  });

  test("setUrlAssetMode clears the registry", async () => {
    setUrlAssetMode("build");
    await registerUrlAsset(fixture);
    expect(getUrlAssets().size).toBe(1);
    setUrlAssetMode("build");
    expect(getUrlAssets().size).toBe(0);
  });
});
