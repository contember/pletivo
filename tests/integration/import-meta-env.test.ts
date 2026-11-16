import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import path from "path";
import fs from "fs/promises";
import { build } from "../../packages/pletivo/src/build";
import { __resetForTests } from "../../packages/pletivo/src/astro-host/runner";
import type { PletivoConfig } from "../../packages/pletivo/src/config";

const fixtureRoot = path.join(import.meta.dir, "../fixture-astro-import-meta-env");
const distDir = path.join(fixtureRoot, "dist");

const config: PletivoConfig = {
  host: "localhost",
  outDir: "dist",
  port: 3000,
  base: "/",
  srcDir: "src",
  publicDir: "public",
};

function textOf(html: string, id: string): string {
  const match = html.match(new RegExp(`id="${id}"[^>]*>([^<]*)<`));
  if (!match) throw new Error(`#${id} not found in ${html}`);
  return match[1].replaceAll("&quot;", '"');
}

describe("import.meta.env in an Astro project build", () => {
  let index: string;
  let notes: string;

  beforeAll(async () => {
    __resetForTests();
    process.env.PUBLIC_FIXTURE_VAR = "from-env";
    await build(fixtureRoot, config);
    index = await Bun.file(path.join(distDir, "index.html")).text();
    notes = await Bun.file(path.join(distDir, "notes", "index.html")).text();
  });

  afterAll(async () => {
    __resetForTests();
    delete process.env.PUBLIC_FIXTURE_VAR;
    await fs.rm(distDir, { recursive: true, force: true });
  });

  test("a plain .ts module sees Astro's built-ins and the process env", () => {
    expect(JSON.parse(textOf(index, "module"))).toEqual({
      base: "/docs",
      mode: "production",
      dev: false,
      prod: true,
      ssr: true,
      site: "https://example.com",
      publicVar: "from-env",
    });
  });

  test("an .astro component sees the same values", () => {
    expect(textOf(index, "astro")).toBe("/docs|production");
  });

  test("an .mdx page sees the same values", () => {
    expect(textOf(notes, "mdx")).toBe("/docs|true");
  });
});
