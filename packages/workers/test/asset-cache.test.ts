import { describe, expect, test } from "bun:test";
import { GeneratedAssetCache } from "../src/asset-cache.ts";
import type { RenderedAsset } from "../src/render.ts";

function asset(path: string, body: string): RenderedAsset {
  return { path, body, contentType: "text/plain" };
}

function held(cache: GeneratedAssetCache, paths: readonly string[]): string[] {
  return paths.filter((path) => cache.get(path) !== undefined);
}

describe("GeneratedAssetCache", () => {
  test("evicts the least recently used entry by count", () => {
    const cache = new GeneratedAssetCache({ maxEntries: 2, maxBytes: 100 });
    cache.putAll([asset("/a", "a"), asset("/b", "b")]);
    expect(cache.get("/a")?.path).toBe("/a");
    cache.putAll([asset("/c", "c")]);

    expect(cache.get("/b")).toBeUndefined();
    expect(held(cache, ["/a", "/c"])).toEqual(["/a", "/c"]);
  });

  test("keeps the encoded byte budget after every batch entry", () => {
    const cache = new GeneratedAssetCache({ maxEntries: 3, maxBytes: 4 });
    // "€" is three UTF-8 bytes, so `/a` has to go to make room, and then `/b` for `/c`.
    const rejected = cache.putAll([asset("/a", "aa"), asset("/b", "€"), asset("/c", "cc")]);

    expect(rejected.map((entry) => entry.path)).toEqual(["/a", "/b"]);
    expect(held(cache, ["/a", "/b", "/c"])).toEqual(["/c"]);
  });

  test("does not retain an oversized entry, and drops the one it replaces", () => {
    const cache = new GeneratedAssetCache({ maxEntries: 2, maxBytes: 3 });
    cache.putAll([asset("/large", "ok")]);
    const oversized = asset("/large", "too large");

    expect(cache.putAll([oversized])).toEqual([oversized]);
    expect(cache.get("/large")).toBeUndefined();
  });

  test("reports oversized and batch-evicted assets to the caller", () => {
    const cache = new GeneratedAssetCache({ maxEntries: 2, maxBytes: 2 });
    const first = asset("/a", "a");
    const second = asset("/b", "b");
    const third = asset("/c", "c");
    const oversized = asset("/large", "large");

    expect(cache.putAll([first, second, third, oversized])).toEqual([first, oversized]);
    expect(held(cache, ["/a", "/b", "/c", "/large"])).toEqual(["/b", "/c"]);
  });

  test("rejects a budget that is not a non-negative finite number", () => {
    expect(() => new GeneratedAssetCache({ maxEntries: 1.5, maxBytes: 1 })).toThrow(/maxEntries/);
    expect(() => new GeneratedAssetCache({ maxEntries: 1, maxBytes: -1 })).toThrow(/maxBytes/);
  });

  test("holds nothing with a zero entry budget", () => {
    const cache = new GeneratedAssetCache({ maxEntries: 0, maxBytes: 100 });
    const only = asset("/a", "a");
    expect(cache.putAll([only])).toEqual([only]);
    expect(cache.get("/a")).toBeUndefined();
  });
});
