/**
 * `injectScript("page")` scripts import packages and Vite virtual modules, which a browser
 * cannot resolve. The build, dev and `pletivo prepare` must all carry the same bundled
 * module inline; the Workers host renders it from the artifact (`packages/workers/test/
 * fixture-parity.test.ts` holds that render byte-for-byte against this build).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import fs from "fs/promises";
import path from "path";
import { startDevServer, type DevServer } from "../support/dev-server";
import { build } from "../../packages/pletivo/src/build";
import { __resetForTests } from "../../packages/pletivo/src/astro-host/runner";
import { prepare } from "../../packages/pletivo/src/prepare/index";
import type { PletivoConfig } from "../../packages/pletivo/src/config";

const fixtureRoot = path.join(import.meta.dir, "../fixture-astro-page-scripts");
const distDir = path.join(fixtureRoot, "dist");

const config: PletivoConfig = {
  host: "localhost",
  outDir: "dist",
  port: 3000,
  base: "/",
  srcDir: "src",
  publicDir: "public",
};

/** The last one must survive verbatim: a string replacement would rewrite `$$`, `$&` and `$'`. */
const MARKERS = ["page-script-lib-marker", "virtual-entry-marker-", "second-script-marker", `"$$|$&|$'"`];

afterEach(() => {
  __resetForTests();
});

/** Bodies of the page's inline module scripts. */
function inlineModules(html: string): string[] {
  return [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)].map((match) => match[1]);
}

function expectBundled(code: string): void {
  for (const marker of MARKERS) expect(code).toContain(marker);
  expect(code).not.toMatch(/\bimport\b/);
  expect(code).not.toContain("virtual:");
  expect(code).not.toContain(": string");
}

describe("injectScript('page') bundling", () => {
  let index: string;
  let about: string;

  beforeAll(async () => {
    __resetForTests();
    await build(fixtureRoot, config);
    index = await Bun.file(path.join(distDir, "index.html")).text();
    about = await Bun.file(path.join(distDir, "about/index.html")).text();
  });

  afterAll(async () => {
    await fs.rm(distDir, { recursive: true, force: true });
  });

  test("build emits every page script as one bundled inline module", () => {
    const modules = inlineModules(index);
    expect(modules).toHaveLength(1);
    expectBundled(modules[0]);
  });

  test("build emits the same module on every page", () => {
    expect(inlineModules(about)).toEqual(inlineModules(index));
  });

  test("each script keeps its own top-level scope", () => {
    // Both scripts declare `label`: one shared scope would fail the bundle, and the build.
    const code = inlineModules(index)[0];
    expect(code).toContain('"first"');
    expect(code).toContain('"second-script-marker"');
  });

  test("build inserts the page <style> verbatim", () => {
    const styles = [...index.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((match) => match[1]);
    expect(styles.some((css) => css.includes(`content:"$$|$&|$'"`))).toBe(true);
  });

  test("prepare freezes the module the build emits", async () => {
    const site = await prepare(fixtureRoot);
    expect(site.artifact.scripts.page).toHaveLength(1);
    expectBundled(site.artifact.scripts.page[0]);
    expect(site.artifact.scripts.page).toEqual(inlineModules(index));
  }, 60_000);

  describe("dev", () => {
    let server: DevServer | undefined;
    let html: string;

    beforeAll(async () => {
      server = await startDevServer({ cwd: fixtureRoot, args: ["--host", "127.0.0.1", "--no-restart"], timeoutMs: 45_000 });
      html = await fetchWhenUp(`${server.url}/`);
    }, 60_000);

    afterAll(async () => {
      await server?.stop();
    });

    test("serves the module the build emits", () => {
      const modules = inlineModules(html).filter((code) => code.includes(MARKERS[0]));
      expect(modules).toHaveLength(1);
      expectBundled(modules[0]);
      expect(modules[0]).toBe(inlineModules(index)[0]);
    });
  });
});

describe("page script served by a plugin from astro:build:setup", () => {
  const root = path.join(import.meta.dir, "../fixture-astro-page-scripts-build-setup");

  afterAll(async () => {
    await fs.rm(path.join(root, "dist"), { recursive: true, force: true });
  });

  test("build runs the hook before it bundles the page scripts", async () => {
    __resetForTests();
    await build(root, config);
    const html = await Bun.file(path.join(root, "dist/index.html")).text();
    const modules = inlineModules(html);
    expect(modules).toHaveLength(1);
    expect(modules[0]).toContain("build-setup-marker");
    expect(modules[0]).not.toContain("virtual:");
  }, 60_000);
});

/** The page body once the dev server answers it with a 200. */
async function fetchWhenUp(url: string): Promise<string> {
  const deadline = Date.now() + 50_000;
  while (Date.now() < deadline) {
    const response = await fetch(url).catch(() => undefined);
    if (response?.ok) return await response.text();
    await Bun.sleep(250);
  }
  throw new Error(`dev server did not serve ${url} in time`);
}
