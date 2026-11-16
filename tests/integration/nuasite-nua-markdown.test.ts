/**
 * A real `@nuasite/nua` config, which since Astro 7 registers its remark/rehype plugins on
 * `markdown.processor` (`unified()` from `@astrojs/markdown-remark`) instead of the top-level
 * `markdown.remarkPlugins`. Its CMS directives must still run in dev and reach the prepared artifact.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import path from "path";
import { __resetForTests } from "../../packages/pletivo/src/astro-host/runner";
import { prepare } from "../../packages/pletivo/src/prepare/index";

const fixtureRoot = path.join(import.meta.dir, "../fixture-nuasite-nua");
const cli = path.join(import.meta.dir, "../../packages/pletivo/src/cli.ts");

afterEach(() => {
  __resetForTests();
});

describe("@nuasite/nua markdown on the unified() processor", () => {
  describe("dev", () => {
    let server: ReturnType<typeof Bun.spawn> | undefined;
    let html: string;

    beforeAll(async () => {
      const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
      const port = probe.port;
      probe.stop(true);
      server = Bun.spawn(["bun", cli, "dev", "--host", "127.0.0.1", "--port", String(port), "--no-restart"], {
        cwd: fixtureRoot,
        stdout: "ignore",
        stderr: "inherit",
      });
      html = await fetchWhenUp(`http://127.0.0.1:${port}/`);
    }, 60_000);

    afterAll(async () => {
      server?.kill();
      await server?.exited;
    });

    test("renders the CMS youtube directive", () => {
      expect(html).toContain('class="youtube-embed"');
      expect(html).toContain("youtube-nocookie.com/embed/dQw4w9WgXcQ");
      expect(html).not.toContain("::youtube");
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
async function fetchWhenUp(url: string): Promise<string> {
  const deadline = Date.now() + 50_000;
  while (Date.now() < deadline) {
    const response = await fetch(url).catch(() => undefined);
    if (response?.ok) return await response.text();
    await Bun.sleep(250);
  }
  throw new Error(`dev server did not serve ${url} in time`);
}
