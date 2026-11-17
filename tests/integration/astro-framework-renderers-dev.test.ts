/**
 * `pletivo dev` renders framework components as islands and serves their client bundles
 * at the URLs the page references, built on request.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "fs/promises";
import path from "path";

const root = path.join(import.meta.dir, "../fixture-astro-renderers-vue");
const component = path.join(root, "src/components/Counter.vue");
let componentSource = "";
const cli = path.resolve(import.meta.dir, "../../packages/pletivo/src/cli.ts");
const PORT = 5600 + Math.floor(Math.random() * 1000);
const BASE = `http://localhost:${PORT}`;

let server: ReturnType<typeof Bun.spawn> | null = null;
let output = "";

beforeAll(async () => {
  componentSource = await fs.readFile(component, "utf8");
  const child = Bun.spawn(["bun", cli, "dev", String(PORT), "--no-restart"], { cwd: root, stdout: "pipe", stderr: "pipe" });
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
  await fs.writeFile(component, componentSource);
});

test("a dev page renders the island, and its component and renderer URLs serve modules", async () => {
  const response = await fetch(`${BASE}/`);
  const html = await response.text();
  expect({ status: response.status, output }).toMatchObject({ status: 200 });
  const island = html.match(/<astro-island [^>]*>/)?.[0] ?? "";
  expect(island).toContain('client="load"');
  expect(html).toContain("vue 1</button>");
  expect(html).not.toContain("pletivo-island-prescript");

  const urls = [...island.matchAll(/ (component-url|renderer-url)="([^"]+)"/g)].map((match) => match[2]);
  expect(urls).toHaveLength(2);
  for (const url of urls) {
    const bundle = await fetch(`${BASE}${url}`);
    expect({ url, status: bundle.status }).toEqual({ url, status: 200 });
    expect(bundle.headers.get("content-type")).toContain("javascript");
    // A module whose relative chunk imports the server serves too.
    const code = await bundle.text();
    for (const [, chunk] of code.matchAll(/from"\.\/([^"]+\.js)"/g)) {
      expect((await fetch(new URL(chunk, `${BASE}${url}`))).status).toBe(200);
    }
  }
}, 60_000);

test("an edit to the component's style reaches the dev stylesheet", async () => {
  const stylesheet = async () => {
    // The page render imports the component, which registers its CSS.
    await (await fetch(`${BASE}/`)).text();
    return (await fetch(`${BASE}/__styles.css`)).text();
  };
  // Served through Bun's CSS bundler, which writes colours in hex.
  expect(await stylesheet()).toContain("#0d0e0f");
  await fs.writeFile(component, componentSource.replace("rgb(13, 14, 15)", "rgb(16, 17, 18)"));
  let css = "";
  for (let attempt = 0; attempt < 50; attempt++) {
    css = await stylesheet();
    if (css.includes("#101112")) break;
    await Bun.sleep(100);
  }
  expect(css).toContain("#101112");
  expect(css).not.toContain("#0d0e0f");
}, 30_000);
