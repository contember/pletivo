import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import path from "path";
import fs from "fs/promises";
import { build } from "../../packages/pletivo/src/build";
import { __resetForTests } from "../../packages/pletivo/src/astro-host/runner";
import type { PletivoConfig } from "../../packages/pletivo/src/config";

const fixtureRoot = path.join(import.meta.dir, "../fixture-astro-hoisted-imports");
const distDir = path.join(fixtureRoot, "dist");

const config: PletivoConfig = {
  outDir: "dist",
  port: 3000,
  base: "/",
  srcDir: "src",
  publicDir: "public",
};

describe("astro hoisted <script> with relative import", () => {
  let html: string;
  let bundlePath: string;
  let bundle: string;

  beforeAll(async () => {
    __resetForTests();
    await build(fixtureRoot, config);
    html = await Bun.file(path.join(distDir, "index.html")).text();
    const m = html.match(/\/_astro\/hoisted-([a-f0-9]+)\.js/);
    expect(m).not.toBeNull();
    bundlePath = path.join(distDir, "_astro", `hoisted-${m![1]}.js`);
    bundle = await Bun.file(bundlePath).text();
  });

  afterAll(async () => {
    __resetForTests();
    await fs.rm(distDir, { recursive: true, force: true });
  });

  test("page references the bundled hoisted script via src=", () => {
    expect(html).toMatch(/<script type="module" src="\/_astro\/hoisted-[a-f0-9]+\.js"><\/script>/);
  });

  test("relative import is resolved into the bundle", async () => {
    // The literal string `EXTERNAL_MARKER` is dead-code-eliminated under
    // minification (the export isn't read), but its only consumer — the
    // assignment `dataset.externalLoaded = EXTERNAL_MARKER` — survives,
    // so the marker string ends up inlined.
    expect(bundle).toContain("external-marker-from-disk");
    expect(bundle).toContain("externalLoaded");
  });

  test("bundle does not contain unresolved import statements", () => {
    // If the import wasn't resolved, the bundle would still have an
    // `import '../scripts/external.js'` statement that the browser would
    // 404 on. After bundling, no relative-path imports should remain.
    expect(bundle).not.toMatch(/import\s+['"]\.\.?\//);
  });
});
