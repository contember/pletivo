import { describe, expect, test } from "bun:test";
import { retainedBytes } from "../src/retained-bytes.ts";

const UNLIMITED = Number.MAX_SAFE_INTEGER;

function fields(count: number): Record<string, string> {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => [`field${index}`, "value"]));
}

describe("retainedBytes", () => {
  test("counts a shared object once, and each copy of it on its own", () => {
    const base = fields(50);
    const shared = retainedBytes({ items: Array.from({ length: 200 }, () => base) }, UNLIMITED);
    const copied = retainedBytes({ items: Array.from({ length: 200 }, () => ({ ...base })) }, UNLIMITED);

    expect(shared).toBeLessThan(retainedBytes(base, UNLIMITED) * 2 + 200 * 32);
    expect(copied).toBeGreaterThan(200 * 50 * 16);
  });

  test("follows a cycle once", () => {
    const node: { name: string; self?: unknown } = { name: "loop" };
    node.self = node;

    expect(retainedBytes(node, UNLIMITED)).toBeLessThan(200);
  });

  test("stops counting once past the limit", () => {
    const large = { items: Array.from({ length: 100_000 }, (_, index) => ({ index })) };

    const bytes = retainedBytes(large, 1_000);

    expect(bytes).toBeGreaterThan(1_000);
    expect(bytes).toBeLessThan(10_000);
  });
});
