import { describe, expect, test } from "bun:test";
import { GeneratedAssetCache } from "../src/asset-cache.ts";

interface Asset {
  path: string;
  body: string | Uint8Array;
  contentType: string;
}

function asset(path: string, body: string | Uint8Array): Asset {
  return { path, body, contentType: "text/plain" };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let settle: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return {
    promise,
    resolve() {
      if (!settle) throw new Error("Deferred promise was not initialized");
      settle();
    },
  };
}

describe("GeneratedAssetCache", () => {
  test("evicts the least recently used entry by count", () => {
    const cache = new GeneratedAssetCache<Asset>({ maxEntries: 2, maxBytes: 100 });
    cache.put(asset("/a", "a"));
    cache.put(asset("/b", "b"));
    expect(cache.get("/a")?.path).toBe("/a");
    cache.put(asset("/c", "c"));

    expect(cache.keys()).toEqual(["/a", "/c"]);
    expect(cache.get("/b")).toBeUndefined();
  });

  test("keeps both count and encoded byte budgets after every batch entry", () => {
    const cache = new GeneratedAssetCache<Asset>({ maxEntries: 3, maxBytes: 4 });
    function* batch(): Iterable<Asset> {
      yield asset("/a", "aa");
      expect(cache.count).toBeLessThanOrEqual(3);
      expect(cache.byteSize).toBeLessThanOrEqual(4);
      yield asset("/b", "€");
      expect(cache.count).toBeLessThanOrEqual(3);
      expect(cache.byteSize).toBeLessThanOrEqual(4);
      yield asset("/c", Uint8Array.of(1, 2));
    }

    cache.putAll(batch());
    expect(cache.keys()).toEqual(["/c"]);
    expect(cache.byteSize).toBe(2);
  });

  test("returns an oversized entry once without retaining it", () => {
    const cache = new GeneratedAssetCache<Asset>({ maxEntries: 2, maxBytes: 3 });
    cache.put(asset("/large", "ok"));
    const oversized = asset("/large", "too large");

    expect(cache.put(oversized)).toBe(oversized);
    expect(cache.get("/large")).toBeUndefined();
    expect(cache.count).toBe(0);
    expect(cache.byteSize).toBe(0);
  });

  test("reports oversized and batch-evicted assets to the caller", () => {
    const cache = new GeneratedAssetCache<Asset>({ maxEntries: 2, maxBytes: 2 });
    const first = asset("/a", "a");
    const second = asset("/b", "b");
    const third = asset("/c", "c");
    const oversized = asset("/large", "large");

    expect(cache.putAll([first, second, third, oversized])).toEqual([first, oversized]);
    expect(cache.keys()).toEqual(["/b", "/c"]);
    expect(cache.count).toBe(2);
    expect(cache.byteSize).toBe(2);
  });

  test("has deterministic atomic put/get semantics across async callers", async () => {
    const cache = new GeneratedAssetCache<Asset>({ maxEntries: 2, maxBytes: 2 });
    const firstPut = deferred();
    const continueWriter = deferred();
    const writer = async () => {
      cache.put(asset("/a", "a"));
      firstPut.resolve();
      await continueWriter.promise;
      cache.put(asset("/c", "c"));
    };

    const writing = writer();
    await firstPut.promise;
    expect(cache.get("/a")?.body).toBe("a");
    cache.put(asset("/b", "b"));
    continueWriter.resolve();
    await writing;

    expect(cache.keys()).toEqual(["/b", "/c"]);
    expect(cache.count).toBe(2);
    expect(cache.byteSize).toBe(2);
  });
});
