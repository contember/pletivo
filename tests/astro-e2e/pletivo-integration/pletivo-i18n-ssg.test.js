/**
 * SSG smoke test for pletivo's i18n drop-in compat layer, running
 * against Astro's own `i18n-routing*` fixtures (copied by setup.ts).
 *
 * We intentionally do NOT mirror Astro's own `i18n-routing.test.js`,
 * which is heavy on:
 *   - Inline `loadFixture({ i18n: {...} })` config overrides (we'd
 *     need to synthesize a temp astro.config.mjs per call)
 *   - Test adapter / SSR output modes
 *   - Server islands
 *   - `[DEV]` tests that run the dev server
 *
 * Instead this file verifies static build output against the fixtures'
 * own `astro.config.mjs`, which is what "drop-in" actually means for
 * the SSG case.
 */

import * as assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import * as cheerio from "cheerio";
import { loadFixture } from "../integration-test-utils.js";

describe("[pletivo] i18n-routing SSG build", () => {
  let fixture;

  before(async () => {
    fixture = await loadFixture({
      root: "./integration-fixtures/i18n-routing/",
    });
    await fixture.build();
  });

  after(async () => {
    await fixture.clean();
  });

  it("renders the default locale index at root (prefixDefault=false)", async () => {
    // i18n-routing's defaultLocale is "spanish" (path alias) with
    // prefixDefaultLocale=false. The root page is src/pages/index.astro.
    const html = await fixture.readFile("/index.html");
    const $ = cheerio.load(html);
    assert.ok($("body").length > 0);
  });

  it("renders the en locale-subdir page at /en/start/", async () => {
    const html = await fixture.readFile("/en/start/index.html");
    // i18n-routing fixture's en/start.astro contains "Hello"
    assert.match(html, /Hello/);
  });

  it("renders the pt locale-subdir page at /pt/start/", async () => {
    const html = await fixture.readFile("/pt/start/index.html");
    // i18n-routing's pt/start.astro contains "Hola"
    assert.match(html, /Hola/);
  });

  it("renders the aliased spanish locale index at /spanish/", async () => {
    // spanish is the default locale — with prefix=false, the root
    // is served from src/pages/index.astro, but spanish/index.astro
    // ALSO exists and should render at /spanish/index.html.
    const html = await fixture.readFile("/spanish/index.html");
    assert.ok(html.length > 0);
  });

  it("renders Astro.currentLocale correctly on a locale page", async () => {
    // current-locale.astro sits at src/pages/ (root) and reports
    // Astro.currentLocale. With prefixDefault=false + default=spanish,
    // the root page's currentLocale is the default ("es").
    const html = await fixture.readFile("/current-locale/index.html");
    // Match the fixture's own `Current Locale: {value}` format.
    assert.match(html, /Current Locale:\s*es/);
  });

  it("renders astro:i18n virtual-module helpers", async () => {
    const html = await fixture.readFile("/virtual-module/index.html");
    assert.match(html, /Virtual module doesn't break/);
    assert.match(html, /About:\s*\/pt\/about/);
    assert.match(html, /About spanish:\s*\/spanish\/about/);
    assert.match(html, /Spain path:\s*spanish/);
    assert.match(html, /Preferred path:\s*es/);
  });
});

describe("[pletivo] i18n-routing-prefix-always SSG build", () => {
  let fixture;

  before(async () => {
    fixture = await loadFixture({
      root: "./integration-fixtures/i18n-routing-prefix-always/",
    });
    await fixture.build();
  });

  after(async () => {
    await fixture.clean();
  });

  it("renders the en locale at /en/start/", async () => {
    const html = await fixture.readFile("/en/start/index.html");
    assert.match(html, /Start/);
  });

  it("renders the pt locale at /pt/start/", async () => {
    const html = await fixture.readFile("/pt/start/index.html");
    assert.match(html, /Oi essa e start/);
  });

  it("renders the aliased spanish locale at /spanish/start/", async () => {
    const html = await fixture.readFile("/spanish/start/index.html");
    assert.match(html, /Espanol/);
  });

  it("emits a redirect from unprefixed root to /en/", async () => {
    // prefixDefaultLocale=true + redirectToDefaultLocale=true (default)
    // means /new-site/ should redirect to /new-site/en/.
    // Static output: index.html contains a meta-refresh to /en.
    const html = await fixture.readFile("/index.html");
    assert.match(html, /http-equiv="refresh"/);
    assert.match(html, /\/new-site\/en\b/);
  });

  it("does NOT emit an it/ page without a fallback", async () => {
    // i18n-routing-prefix-always does not declare fallback → it
    // missing pages stay 404 (no static file written).
    assert.equal(fixture.pathExists("/it/start/index.html"), false);
  });
});

describe("[pletivo] i18n-routing-fallback SSG build", () => {
  let fixture;

  before(async () => {
    fixture = await loadFixture({
      root: "./integration-fixtures/i18n-routing-fallback/",
    });
    await fixture.build();
  });

  after(async () => {
    await fixture.clean();
  });

  it("renders the source en pages at their expected URLs", async () => {
    // Astro's fallback fixture places pages under src/pages/ root
    // (en is default with prefixDefault=false) and in pt/ / it/
    // subdirs. We verify the en pages exist at the root URL.
    const html = await fixture.readFile("/start/index.html");
    assert.match(html, /Start|start/);
  });

  it("synthesizes missing pt pages from en via fallback chain", async () => {
    // pt has fallback → en. For pages only present in en/, pt/…
    // should be generated from the en source.
    const html = await fixture.readFile("/pt/start/index.html");
    assert.ok(html.length > 0);
  });

  it("synthesizes missing it pages from en via fallback chain", async () => {
    const html = await fixture.readFile("/it/start/index.html");
    assert.ok(html.length > 0);
  });
});
