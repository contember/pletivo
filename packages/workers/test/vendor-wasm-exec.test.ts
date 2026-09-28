import { describe, expect, test } from "bun:test";
import path from "node:path";

/**
 * `src/vendor/wasm_exec.js` is a copy of a chunk inside `@astrojs/compiler`.
 * Re-derive it here so an upgrade that moves the chunk, or changes the line we
 * patch, fails loudly instead of leaving a stale Go runtime behind.
 */

const UNGUARDED_GLOBALS =
  "Object.defineProperties(globalThis,{fs:{value:w,enumerable:!0},process:{value:b,enumerable:!0}});";
const GUARDED_GLOBALS =
  'globalThis.fs||Object.defineProperty(globalThis,"fs",{value:w,enumerable:!0});' +
  'globalThis.process||Object.defineProperty(globalThis,"process",{value:b,enumerable:!0});';

const VENDORED = path.resolve(import.meta.dir, "../src/vendor/wasm_exec.js");

/** The chunk `dist/browser/wasm_exec.js` re-exports, whose name carries a content hash. */
async function upstreamChunk(): Promise<string> {
  const distDir = path.join(
    path.dirname(Bun.resolveSync("@astrojs/compiler/package.json", import.meta.dir)),
    "dist",
  );
  const reexport = await Bun.file(path.join(distDir, "browser/wasm_exec.js")).text();
  const match = reexport.match(/from\s*["']\.\.\/(chunk-[^"']+)["']/);
  if (!match) throw new Error(`no chunk import in browser/wasm_exec.js: ${reexport}`);
  return Bun.file(path.join(distDir, match[1])).text();
}

/** Everything after the provenance header. */
function vendoredCode(source: string): string {
  const lines = source.split("\n");
  let i = 0;
  while (i < lines.length && (lines[i].startsWith("//") || lines[i] === "")) i++;
  return lines.slice(i).join("\n");
}

describe("vendored wasm_exec", () => {
  test("is the upstream chunk with only the global install guarded", async () => {
    const upstream = await upstreamChunk();
    expect(upstream).toContain(UNGUARDED_GLOBALS);
    const expected = upstream.split(UNGUARDED_GLOBALS).join(GUARDED_GLOBALS);
    expect(vendoredCode(await Bun.file(VENDORED).text())).toBe(expected);
  });

  test("does not replace a real `process`", async () => {
    const before = process.env.PATH;
    await import("../src/vendor/wasm_exec.js");
    expect(process.env.PATH).toBe(before);
  });

  test("installs the `fs` global the Go runtime reads at startup", async () => {
    await import("../src/vendor/wasm_exec.js");
    expect(typeof Reflect.get(globalThis, "fs")).toBe("object");
  });
});
