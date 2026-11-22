/**
 * A real `@nuasite/nua` config, which since Astro 7 registers its remark/rehype plugins on
 * `markdown.processor` (`unified()` from `@astrojs/markdown-remark`) instead of the top-level
 * `markdown.remarkPlugins`. Its CMS directives must still run in dev and reach the prepared artifact.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import path from "path";
import { startDevServer, type DevServer } from "../support/dev-server";
import { __resetForTests } from "../../packages/pletivo/src/astro-host/runner";
import { prepare } from "../../packages/pletivo/src/prepare/index";

const fixtureRoot = path.join(import.meta.dir, "../fixture-nuasite-nua");

afterEach(() => {
  __resetForTests();
});

describe("@nuasite/nua markdown on the unified() processor", () => {
  describe("dev", () => {
    let server: DevServer | undefined;
    let html: string;
    let mdxHtml: string;

    beforeAll(async () => {
      server = await startDevServer({ cwd: fixtureRoot, args: ["--host", "127.0.0.1", "--no-restart"], timeoutMs: 45_000 });
      html = await fetchWhenUp(server, "/");
      mdxHtml = await fetchWhenUp(server, "/mdx-page");
    }, 60_000);

    afterAll(async () => {
      await server?.stop();
    });

    test("renders the CMS youtube directive", () => {
      expect(html).toContain('class="youtube-embed"');
      expect(html).toContain("youtube-nocookie.com/embed/dQw4w9WgXcQ");
      expect(html).not.toContain("::youtube");
    });

    test("renders the CMS youtube directive in .mdx", () => {
      expect(mdxHtml).toContain("youtube-nocookie.com/embed/mdxVideo01");
      expect(mdxHtml).not.toContain("::youtube");
    });

    test("marks the rendered markdown for the CMS editor", () => {
      expect(html).toMatch(/<h1[^>]*data-cms-markdown-content/);
    });
  });

  test("prepare freezes the CMS remark plugins for the Workers host", async () => {
    const site = await prepare(fixtureRoot);
    expect(site.artifact.config.markdown?.remarkPlugins).toContainEqual({
      module: "@nuasite/cms/remark",
      export: "remarkDirective",
    });
  }, 60_000);
});

/** The page body once the dev server answers it with a 200. */
async function fetchWhenUp(server: DevServer, pathname: string): Promise<string> {
  const url = `${server.url}${pathname}`;
  const deadline = Date.now() + 50_000;
  while (Date.now() < deadline) {
    const response = await fetch(url).catch(() => undefined);
    if (response?.ok) return await response.text();
    await Bun.sleep(250);
  }
  throw new Error(`dev server did not serve ${url} in time:\n${server.output()}`);
}
