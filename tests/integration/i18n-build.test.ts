import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import path from "path";
import fs from "fs/promises";
import { build } from "../../packages/pletivo/src/build";
import type { PletivoConfig } from "../../packages/pletivo/src/config";

/**
 * End-to-end test for Phase 3: the `astro:i18n` virtual module,
 * `Astro.currentLocale`, and locale-dir routing all working together
 * through a real pletivo build of a mini fixture.
 *
 * Fixture shape mirrors Astro's own `i18n-routing` fixture: default
 * locale `en` at root, `pt/` subdir, plus an aliased `spanish/` dir
 * bound to codes `es`/`es-SP`.
 */

const fixtureRoot = path.join(import.meta.dir, "../fixture-i18n");
const distDir = path.join(fixtureRoot, "dist");

const config: PletivoConfig = {
  outDir: "dist",
  port: 3000,
  base: "/",
  srcDir: "src",
  publicDir: "public",
};

async function readDist(relPath: string): Promise<string> {
  return Bun.file(path.join(distDir, relPath)).text();
}

describe("i18n build", () => {
  beforeAll(async () => {
    await build(fixtureRoot, config);
  });

  afterAll(async () => {
    await fs.rm(distDir, { recursive: true, force: true });
  });

  test("emits the index page for the default locale at root", async () => {
    const html = await readDist("index.html");
    expect(html).toContain("<h1>Home</h1>");
  });

  test("emits pages under non-default locale subdirs at their URL", async () => {
    const html = await readDist("pt/about/index.html");
    expect(html).toContain("<h1>Sobre</h1>");
  });

  test("emits pages under aliased locale subdir", async () => {
    const html = await readDist("spanish/about/index.html");
    expect(html).toContain("<h1>Acerca</h1>");
  });

  test("astro:i18n getRelativeLocaleUrl returns locale URLs", async () => {
    const html = await readDist("index.html");
    expect(html).toContain('data-test="about-pt">aboutPt=/pt/about');
    expect(html).toContain('data-test="about-es">aboutEs=/spanish/about');
  });

  test("astro:i18n getAbsoluteLocaleUrl uses configured site", async () => {
    const html = await readDist("index.html");
    expect(html).toContain(
      'data-test="about-abs-pt">aboutAbsPt=https://example.com/pt/about',
    );
  });

  test("astro:i18n getPathByLocale resolves path alias", async () => {
    const html = await readDist("index.html");
    expect(html).toContain('data-test="spain-path">spainPath=spanish');
  });

  test("astro:i18n getLocaleByPath resolves canonical code", async () => {
    const html = await readDist("index.html");
    expect(html).toContain('data-test="spanish-locale">spanishLocale=es');
  });

  test("Astro.currentLocale is set to default locale on root pages", async () => {
    const html = await readDist("index.html");
    expect(html).toContain('data-test="current-locale">currentLocale=en');
  });

  test("Astro.currentLocale is set from locale subdir", async () => {
    const html = await readDist("pt/about/index.html");
    expect(html).toContain('data-test="current-locale">pt');
  });

  test("Astro.currentLocale uses canonical code for aliased locale", async () => {
    const html = await readDist("spanish/about/index.html");
    expect(html).toContain('data-test="current-locale">es');
  });
});
