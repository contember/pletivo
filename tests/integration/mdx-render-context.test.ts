import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import path from "path";
import { startDevServer, type DevServer } from "../support/dev-server";
import fs from "fs/promises";
import { build } from "../../packages/pletivo/src/build";
import { __resetForTests } from "../../packages/pletivo/src/astro-host/runner";
import type { PletivoConfig } from "../../packages/pletivo/src/config";

const fixtureRoot = path.join(import.meta.dir, "../fixture-mdx-render-context");
const distDir = path.join(fixtureRoot, "dist");

const config: PletivoConfig = {
  host: "localhost",
  outDir: "dist",
  port: 3000,
  base: "/",
  srcDir: "src",
  publicDir: "public",
};

// The fixture's MDX entry renders `Here.astro`, which prints `Astro.url.pathname` and a
// local the .astro page sets. The component is called with props alone, as MDX calls it.
describe("an .astro component inside MDX content rendered by a page", () => {
  describe("build", () => {
    let astroPage: string;
    let tsxPage: string;

    beforeAll(async () => {
      __resetForTests();
      await build(fixtureRoot, config);
      astroPage = await Bun.file(path.join(distDir, "docs/intro/index.html")).text();
      tsxPage = await Bun.file(path.join(distDir, "tsx-page/index.html")).text();
    });

    afterAll(async () => {
      __resetForTests();
      await fs.rm(distDir, { recursive: true, force: true });
    });

    test("from an .astro page: Astro.url and Astro.locals are the page's", () => {
      expect(astroPage).toContain("path /docs/intro/, locals set by the page");
    });

    test("from a .tsx page: Astro.url is the page's", () => {
      expect(tsxPage).toContain("path /tsx-page/, locals undefined");
    });
  });

  describe("dev", () => {
    let server: DevServer | undefined;
    let base: string;

    beforeAll(async () => {
      server = await startDevServer({ cwd: fixtureRoot, args: ["--host", "127.0.0.1", "--no-restart"], timeoutMs: 45_000 });
      base = server.url;
    }, 60_000);

    afterAll(async () => {
      await server?.stop();
    });

    test("from an .astro page: Astro.url and Astro.locals are the page's", async () => {
      // Dev serves the route without the trailing slash a build writes.
      expect(await fetchWhenUp(`${base}/docs/intro/`)).toContain("path /docs/intro, locals set by the page");
    }, 60_000);

    test("from a .tsx page: Astro.url is the page's", async () => {
      expect(await fetchWhenUp(`${base}/tsx-page/`)).toContain("path /tsx-page, locals undefined");
    }, 60_000);
  });
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
