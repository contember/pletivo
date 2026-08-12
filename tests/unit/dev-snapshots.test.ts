import { describe, expect, test } from "bun:test";
import { createSnapshotStore } from "../../packages/pletivo/src/dev-snapshots";

const page = (size: number) => "x".repeat(size);

describe("createSnapshotStore", () => {
  // The bug this replaces: every successful render was stored, but only `dev.stale` ever read
  // it back, so a project without stale mode retained the full HTML of every path it served —
  // hundreds of MB on a content site — and never looked at any of it.
  test("stores nothing when nobody will read it back", () => {
    const store = createSnapshotStore({ enabled: false });
    store.remember("/a", page(1000));
    expect(store.get("/a")).toBeUndefined();
    expect(store.size).toBe(0);
    expect(store.chars).toBe(0);
  });

  test("returns the last HTML served for a path", () => {
    const store = createSnapshotStore({ enabled: true });
    store.remember("/a", "<html>first</html>");
    store.remember("/a", "<html>second</html>");
    expect(store.get("/a")).toBe("<html>second</html>");
    expect(store.size).toBe(1);
  });

  test("re-writing a path does not double-count it", () => {
    const store = createSnapshotStore({ enabled: true });
    store.remember("/a", page(100));
    store.remember("/a", page(30));
    expect(store.chars).toBe(30);
  });

  test("evicts the oldest write once the budget is exceeded", () => {
    const store = createSnapshotStore({ enabled: true, budgetChars: 250 });
    store.remember("/a", page(100));
    store.remember("/b", page(100));
    store.remember("/c", page(100));
    expect(store.get("/a")).toBeUndefined();
    expect(store.get("/b")).toBe(page(100));
    expect(store.get("/c")).toBe(page(100));
    expect(store.chars).toBe(200);
  });

  // The page being edited is served over and over, and is exactly the one stale mode exists to
  // protect — it must not age out just because it was first.
  test("a path that keeps being served keeps its place", () => {
    const store = createSnapshotStore({ enabled: true, budgetChars: 250 });
    store.remember("/a", page(100));
    store.remember("/b", page(100));
    store.remember("/a", page(100));
    store.remember("/c", page(100));
    expect(store.get("/b")).toBeUndefined();
    expect(store.get("/a")).toBe(page(100));
    expect(store.get("/c")).toBe(page(100));
  });

  test("a single page larger than the whole budget does not wedge the store", () => {
    const store = createSnapshotStore({ enabled: true, budgetChars: 50 });
    store.remember("/big", page(500));
    expect(store.size).toBe(0);
    expect(store.chars).toBe(0);
    store.remember("/small", page(10));
    expect(store.get("/small")).toBe(page(10));
  });
});
