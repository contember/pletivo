/**
 * `pletivo dev` renders framework components as islands and serves their client bundles at
 * the URLs the page references, built on request; edits reach the next render without a
 * restart. The server runs on a copy of the fixture inside `tests/` (so the repo's
 * `node_modules` resolve), which the tests edit.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "fs/promises";
import path from "path";

const template = path.join(import.meta.dir, "../fixture-astro-renderers-dev");
const cli = path.resolve(import.meta.dir, "../../packages/pletivo/src/cli.ts");
const PORT = 5600 + Math.floor(Math.random() * 1000);
const BASE = `http://localhost:${PORT}`;

let root = "";
let server: ReturnType<typeof Bun.spawn> | null = null;
let output = "";

const ISLAND_SCRIPT = 'customElements.define("astro-island"';
const directiveScript = (directive: string) => `(self.Astro||(self.Astro={})).${directive}=`;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(import.meta.dir, "../.renderers-dev-"));
  await fs.cp(template, root, { recursive: true });
  const child = Bun.spawn(["bun", cli, "dev", String(PORT), "--no-restart", "--error-page=src/errors/Error.astro"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  server = child;
  const decoder = new TextDecoder();
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) output += decoder.decode(chunk);
  };
  void collect(child.stdout);
  void collect(child.stderr);
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await fetch(`${BASE}/__hmr_ping`);
      return;
    } catch {
      await Bun.sleep(100);
    }
  }
  throw new Error(`the dev server did not start:\n${output}`);
}, 30_000);

afterAll(async () => {
  server?.kill();
  await server?.exited;
  if (root) await fs.rm(root, { recursive: true, force: true });
});

async function page(pathname: string): Promise<{ status: number; html: string }> {
  const response = await fetch(`${BASE}${pathname}`);
  return { status: response.status, html: await response.text() };
}

/** Fetch `pathname` until `done` holds for its HTML, as a file change lands after the watcher fires. */
async function pageUntil(pathname: string, done: (html: string) => boolean): Promise<string> {
  let html = "";
  for (let attempt = 0; attempt < 50; attempt++) {
    html = (await page(pathname)).html;
    if (done(html)) return html;
    await Bun.sleep(100);
  }
  return html;
}

function islandUrls(html: string): string[] {
  return [...html.matchAll(/<astro-island [^>]*>/g)].flatMap((match) =>
    [...match[0].matchAll(/ (component-url|renderer-url)="([^"]+)"/g)].map((url) => url[2]),
  );
}

/** Each URL serves a module, and so does every relative chunk it imports. */
async function expectModules(urls: readonly string[]): Promise<void> {
  expect(urls.length).toBeGreaterThan(0);
  for (const url of urls) {
    const bundle = await fetch(`${BASE}${url}`);
    const code = await bundle.text();
    expect({ url, status: bundle.status, body: bundle.status === 200 ? "" : code }).toEqual({ url, status: 200, body: "" });
    expect(bundle.headers.get("content-type")).toContain("javascript");
    for (const [, chunk] of code.matchAll(/from"\.\/([^"]+\.js)"/g)) {
      expect((await fetch(new URL(chunk, `${BASE}${url}`))).status).toBe(200);
    }
  }
}

function expectScriptsSettled(html: string, directive: string): void {
  expect(html).not.toContain("pletivo-island-prescript");
  expect(html.split(ISLAND_SCRIPT).length - 1).toBe(1);
  expect(html.split(directiveScript(directive)).length - 1).toBe(1);
  expect(html.indexOf(ISLAND_SCRIPT)).toBeLessThan(html.indexOf("<astro-island"));
}

test("a dev page renders its islands, and their component and renderer URLs serve modules", async () => {
  const { status, html } = await page("/");
  expect({ status, output }).toMatchObject({ status: 200 });
  expect(html).toContain("vue 1</button>");
  expect(html).toContain("label v1");
  expect(html).toContain("child v1");
  expectScriptsSettled(html, "load");
  await expectModules(islandUrls(html));
}, 60_000);

test("an edit to the component's style reaches the dev stylesheet", async () => {
  const stylesheet = async () => {
    // The page render imports the component, which registers its CSS.
    await page("/");
    return (await fetch(`${BASE}/__styles.css`)).text();
  };
  // Served through Bun's CSS bundler, which writes colours in hex.
  expect(await stylesheet()).toContain("#0d0e0f");
  const counter = path.join(root, "src/components/Counter.vue");
  await fs.writeFile(counter, (await fs.readFile(counter, "utf8")).replace("rgb(13, 14, 15)", "rgb(16, 17, 18)"));
  let css = "";
  for (let attempt = 0; attempt < 50; attempt++) {
    css = await stylesheet();
    if (css.includes("#101112")) break;
    await Bun.sleep(100);
  }
  expect(css).toContain("#101112");
  expect(css).not.toContain("#0d0e0f");
}, 30_000);

test("edits to the files a compiled component imports show without a restart", async () => {
  await fs.writeFile(path.join(root, "src/components/Child.vue"), '<template>\n  <span class="child">child v2</span>\n</template>\n');
  await fs.writeFile(path.join(root, "src/components/label.ts"), 'export const label = "label v2";\n');
  const html = await pageUntil("/", (text) => text.includes("child v2") && text.includes("label v2"));
  expect(html).toContain("child v2");
  expect(html).toContain("label v2");
}, 30_000);

test("the 404 page and the error page render their islands, scripts settled", async () => {
  const missing = await page("/no-such-page");
  expect(missing.status).toBe(404);
  expect(missing.html).toContain("vue 404</button>");
  expectScriptsSettled(missing.html, "idle");
  await expectModules(islandUrls(missing.html));

  const broken = await page("/broken");
  expect(broken.html).toContain("vue 500</button>");
  expectScriptsSettled(broken.html, "visible");
  await expectModules(islandUrls(broken.html));
}, 60_000);

test("renaming a hydrated component breaks no bundle, and its page's new island is served", async () => {
  const before = await page("/rename");
  const [oldUrl] = islandUrls(before.html);
  expect(oldUrl).toContain("/Old.");
  const indexUrls = islandUrls((await page("/")).html);

  await fs.rename(path.join(root, "src/components/Old.vue"), path.join(root, "src/components/New.vue"));
  const renamePage = path.join(root, "src/pages/rename.astro");
  await fs.writeFile(renamePage, (await fs.readFile(renamePage, "utf8")).replace("Old.vue", "New.vue"));
  // The rename page has not rendered since: its record still names the missing Old.vue.
  await Bun.sleep(300);
  await expectModules(indexUrls);

  const after = await pageUntil("/rename", (html) => islandUrls(html).some((url) => url.includes("/New.")));
  const urls = islandUrls(after);
  expect(urls[0]).toContain("/New.");
  await expectModules(urls);
}, 60_000);
