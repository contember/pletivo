import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import path from "path";
import fs from "fs/promises";
import { build } from "../../packages/pletivo/src/build";
import type { PletivoConfig } from "../../packages/pletivo/src/config";

const fallbackRoot = path.join(import.meta.dir, "../fixture-i18n-fallback");
const fallbackDist = path.join(fallbackRoot, "dist");
const prefixRoot = path.join(import.meta.dir, "../fixture-i18n-prefix-always");
const prefixDist = path.join(prefixRoot, "dist");

const baseConfig: PletivoConfig = {
  outDir: "dist",
  port: 3000,
  base: "/",
  srcDir: "src",
  publicDir: "public",
};

async function readFile(dist: string, rel: string): Promise<string> {
  return Bun.file(path.join(dist, rel)).text();
}

describe("i18n fallback (rewrite mode) build", () => {
  beforeAll(async () => {
    await build(fallbackRoot, baseConfig);
  });

  afterAll(async () => {
    await fs.rm(fallbackDist, { recursive: true, force: true });
  });

  test("emits the source pages verbatim", async () => {
    expect(await readFile(fallbackDist, "en/start/index.html")).toContain(
      "<h1>Start</h1>",
    );
    expect(await readFile(fallbackDist, "pt/start/index.html")).toContain(
      "<h1>Oi, Start</h1>",
    );
    expect(await readFile(fallbackDist, "en/blog/index.html")).toContain(
      "<h1>Blog</h1>",
    );
  });

  test("synthesizes it/start from en/start (pt already has its own)", async () => {
    const html = await readFile(fallbackDist, "it/start/index.html");
    expect(html).toContain("<h1>Start</h1>");
    expect(html).toContain('data-test="current-locale">it');
  });

  test("synthesizes pt/blog and it/blog from en/blog", async () => {
    const ptBlog = await readFile(fallbackDist, "pt/blog/index.html");
    const itBlog = await readFile(fallbackDist, "it/blog/index.html");
    expect(ptBlog).toContain("<h1>Blog</h1>");
    expect(ptBlog).toContain('data-test="current-locale">pt');
    expect(itBlog).toContain("<h1>Blog</h1>");
    expect(itBlog).toContain('data-test="current-locale">it');
  });

  test("does NOT overwrite pt/start with the English fallback", async () => {
    const html = await readFile(fallbackDist, "pt/start/index.html");
    expect(html).toContain("Oi, Start");
    expect(html).not.toContain("<h1>Start</h1>");
  });
});

describe("i18n prefixDefaultLocale + redirectToDefaultLocale build", () => {
  beforeAll(async () => {
    await build(prefixRoot, baseConfig);
  });

  afterAll(async () => {
    await fs.rm(prefixDist, { recursive: true, force: true });
  });

  test("emits default-locale pages at their prefixed URL", async () => {
    expect(await readFile(prefixDist, "en/index.html")).toContain(
      "<h1>English Home</h1>",
    );
    expect(await readFile(prefixDist, "en/start/index.html")).toContain(
      "<h1>Start</h1>",
    );
  });

  test("emits pt pages normally", async () => {
    expect(await readFile(prefixDist, "pt/index.html")).toContain(
      "<h1>Home PT</h1>",
    );
  });

  test("emits meta-refresh redirect from unprefixed default-locale URLs", async () => {
    const rootRedirect = await readFile(prefixDist, "index.html");
    expect(rootRedirect).toContain("http-equiv=\"refresh\"");
    expect(rootRedirect).toContain("/new-site/en");

    const startRedirect = await readFile(prefixDist, "start/index.html");
    expect(startRedirect).toContain("http-equiv=\"refresh\"");
    expect(startRedirect).toContain("/new-site/en/start");
  });

  test("non-default locales do not emit unprefixed redirects", async () => {
    // With `prefixDefaultLocale: true`, pt/index.html is already at its
    // correct URL. Nothing should be written at /pt that comes from the
    // redirect generator (it only targets the default locale).
    const ptHtml = await readFile(prefixDist, "pt/index.html");
    expect(ptHtml).not.toContain("http-equiv=\"refresh\"");
  });
});
