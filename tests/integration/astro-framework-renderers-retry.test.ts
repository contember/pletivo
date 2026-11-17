/**
 * A renderer that registers only when a failed `astro:config:setup` is retried in dev gets wired
 * once the retry passes: its components render as islands and their bundles are served, with
 * no restart.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "fs/promises";
import path from "path";

const template = path.join(import.meta.dir, "../fixture-astro-renderers-retry");
const cli = path.resolve(import.meta.dir, "../../packages/pletivo/src/cli.ts");
const PORT = 6600 + Math.floor(Math.random() * 1000);
const BASE = `http://localhost:${PORT}`;

let root = "";
let server: ReturnType<typeof Bun.spawn> | null = null;
let output = "";

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(import.meta.dir, "../.renderers-retry-"));
  await fs.cp(template, root, { recursive: true });
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
  if (root) await fs.rm(root, { recursive: true, force: true });
});

test("the renderer is wired once the retried setup passes", async () => {
  const before = await (await fetch(`${BASE}/`)).text();
  expect(before).not.toContain("<astro-island");

  // A change under src/ retries the failed hook, which now passes.
  await fs.writeFile(path.join(root, "src/ready.txt"), "ready\n");
  let html = "";
  for (let attempt = 0; attempt < 50 && !html.includes("<astro-island"); attempt++) {
    await Bun.sleep(100);
    html = await (await fetch(`${BASE}/`)).text();
  }
  expect({ html, output }).toMatchObject({ html: expect.stringContaining("preact 3</button>") });
  const island = html.match(/<astro-island [^>]*>/)?.[0] ?? "";
  expect(island).toContain('client="load"');
  const urls = [...island.matchAll(/ (component-url|renderer-url)="([^"]+)"/g)].map((match) => match[2]);
  expect(urls).toHaveLength(2);
  for (const url of urls) {
    const bundle = await fetch(`${BASE}${url}`);
    expect({ url, status: bundle.status }).toEqual({ url, status: 200 });
  }
}, 60_000);
