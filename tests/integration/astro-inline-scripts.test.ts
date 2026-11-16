import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import path from "path";
import fs from "fs/promises";
import { build } from "../../packages/pletivo/src/build";
import { __resetForTests } from "../../packages/pletivo/src/astro-host/runner";
import type { PletivoConfig } from "../../packages/pletivo/src/config";

const fixtureRoot = path.join(import.meta.dir, "../fixture-astro-inline-scripts");
const distDir = path.join(fixtureRoot, "dist");

const config: PletivoConfig = {
  host: "localhost",
  outDir: "dist",
  port: 3000,
  base: "/",
  srcDir: "src",
  publicDir: "public",
};

/** Astro inlines a processed script whose bundle imports nothing and is under 4096 B. */
describe("astro <script> inlining", () => {
  let html: string;
  let inlineScripts: string[];
  let linkedScripts: string[];

  beforeAll(async () => {
    __resetForTests();
    await build(fixtureRoot, config);
    html = await Bun.file(path.join(distDir, "index.html")).text();
    inlineScripts = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    linkedScripts = [];
    for (const m of html.matchAll(/<script type="module" src="\/_astro\/(hoisted-[a-f0-9]+\.js)"><\/script>/g)) {
      linkedScripts.push(await Bun.file(path.join(distDir, "_astro", m[1])).text());
    }
  });

  afterAll(async () => {
    __resetForTests();
    await fs.rm(distDir, { recursive: true, force: true });
  });

  test("a small script with no imports is inlined, bundled and TS-stripped", () => {
    const small = inlineScripts.filter((code) => code.includes("small-script-marker"));
    expect(small).toHaveLength(1);
    expect(small[0]).not.toContain(": string");
  });

  test("an inlined script leaves no file behind", async () => {
    const files = await fs.readdir(path.join(distDir, "_astro"));
    const contents = await Promise.all(files.map((file) => Bun.file(path.join(distDir, "_astro", file)).text()));
    expect(contents.some((code) => code.includes("small-script-marker"))).toBe(false);
  });

  test("a script of 4096 B or more stays linked", () => {
    expect(inlineScripts.some((code) => code.includes("large-script-marker"))).toBe(false);
    expect(linkedScripts.some((code) => code.includes("large-script-marker"))).toBe(true);
  });

  test("a script whose bundle still imports stays linked", () => {
    expect(inlineScripts.some((code) => code.includes("remote-script-marker"))).toBe(false);
    expect(linkedScripts.some((code) => code.includes("remote-script-marker"))).toBe(true);
  });
});
