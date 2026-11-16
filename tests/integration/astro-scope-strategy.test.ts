import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import path from "path";
import fs from "fs/promises";
import { build } from "../../packages/pletivo/src/build";
import { __resetForTests } from "../../packages/pletivo/src/astro-host/runner";
import type { PletivoConfig } from "../../packages/pletivo/src/config";

// An Astro project scopes styles with Astro's default strategy, `attribute`:
// `data-astro-cid-*` on the elements, `[data-astro-cid-*]` in the selectors.
const fixtureRoot = path.join(import.meta.dir, "../fixture-astro-scope-strategy");
const distDir = path.join(fixtureRoot, "dist");

const config: PletivoConfig = {
  host: "localhost",
  outDir: "dist",
  port: 3000,
  base: "/",
  srcDir: "src",
  publicDir: "public",
};

describe("Astro project scoped styles", () => {
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

  test("marks elements with data-astro-cid, not a scope class", () => {
    expect(html).toMatch(/<p class="card" data-astro-cid-[a-z0-9]+>/);
    expect(html).toMatch(/<h1 data-astro-cid-[a-z0-9]+>/);
    expect(html).not.toMatch(/\bastro-[a-z0-9]{8}\b(?!-)/);
  });

  test("emits each component's scoped CSS with attribute selectors", () => {
    const cardScope = html.match(/<p class="card" data-astro-cid-([a-z0-9]+)>/)![1];
    const pageScope = html.match(/<h1 data-astro-cid-([a-z0-9]+)>/)![1];
    expect(html).toContain(`.card[data-astro-cid-${cardScope}]`);
    expect(html).toContain(`h1[data-astro-cid-${pageScope}]`);
    expect(html).not.toContain(":where(");
  });
});
