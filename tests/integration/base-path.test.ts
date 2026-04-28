import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import path from "path";
import fs from "fs/promises";
import { build } from "../../packages/pletivo/src/build";
import { __resetForTests } from "../../packages/pletivo/src/astro-host/runner";
import type { PletivoConfig } from "../../packages/pletivo/src/config";

const fixtureRoot = path.join(import.meta.dir, "../fixture-base-path");
const distDir = path.join(fixtureRoot, "dist");

const config: PletivoConfig = {
  outDir: "dist",
  port: 3000,
  base: "/",
  srcDir: "src",
  publicDir: "public",
};

describe("base path: build under base: '/sub-app'", () => {
  let html: string;

  beforeAll(async () => {
    __resetForTests();
    await build(fixtureRoot, config);
    html = await Bun.file(path.join(distDir, "index.html")).text();
  });

  afterAll(async () => {
    __resetForTests();
    await fs.rm(distDir, { recursive: true, force: true });
  });

  test("hoisted <script> URL is prefixed with base", () => {
    expect(html).toMatch(/<script type="module" src="\/sub-app\/_astro\/hoisted-[a-f0-9]+\.js"><\/script>/);
    // Make sure no unprefixed leak slipped through.
    expect(html).not.toMatch(/src="\/_astro\/hoisted-/);
  });

  test("hoisted bundle is written to dist/_astro/ (filesystem path, no base prefix)", async () => {
    const m = html.match(/\/sub-app\/_astro\/hoisted-([a-f0-9]+)\.js/);
    expect(m).not.toBeNull();
    const bundlePath = path.join(distDir, "_astro", `hoisted-${m![1]}.js`);
    const exists = await Bun.file(bundlePath).exists();
    expect(exists).toBe(true);
  });

  test("CSS link tag is prefixed with base", () => {
    // The build's CSS link follows `<base><cssPath>`. cssPath starts with /
    // and base path doesn't end with /, so the result is `/sub-app/...`.
    if (html.includes('rel="stylesheet"')) {
      expect(html).toMatch(/href="\/sub-app\//);
    }
  });
});
