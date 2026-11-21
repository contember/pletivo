import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compareAssets } from "../astro-fixtures/assets";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function output(files: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "astro-fixtures-assets-"));
  dirs.push(root);
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), file);
  }
  return root;
}

describe("compareAssets", () => {
  test("matches assets by name with the hash and Astro's transform suffix erased", () => {
    const astro = output(["_astro/houston.Dm8K3lV8_Z1abc.webp", "_astro/font.B2c-xY_9.woff2", "_astro/index.Ab12Cd34.css"]);
    const pletivo = output(["_astro/houston.d26c3520.webp", "_astro/font.0011aabb.woff2", "assets/styles.1b689b39.css"]);
    const result = compareAssets(astro, pletivo);
    expect(result.astro).toEqual(["font.woff2", "houston.webp"]);
    expect(result.match).toBe(true);
  });

  test("reports an asset one side emits and the other does not, counted as a multiset", () => {
    const astro = output(["_astro/a.Dm8K3lV8.png", "_astro/a.Xy8K3lV8.png", "_astro/b.Dm8K3lV8.svg"]);
    const pletivo = output(["_astro/a.d26c3520.png", "_islands/c.d26c3520.svg", "_astro/x.d26c3520.js"]);
    const result = compareAssets(astro, pletivo);
    expect(result.missing).toEqual(["a.png", "b.svg"]);
    expect(result.extra).toEqual(["c.svg"]);
    expect(result.match).toBe(false);
    expect(result.summary).toBe("assets missing a.png, b.svg; assets extra c.svg");
  });

  test("ignores code and source maps, and anything outside the bundle directories", () => {
    const astro = output(["_astro/page.Dm8K3lV8.js", "_astro/page.Dm8K3lV8.js.map", "favicon.svg"]);
    const pletivo = output(["_islands/Counter.d26c3520.js", "assets/logo.svg"]);
    expect(compareAssets(astro, pletivo).match).toBe(true);
  });
});
