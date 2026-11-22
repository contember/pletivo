/**
 * A renderer that registers only when a failed `astro:config:setup` is retried in dev gets wired
 * once the retry passes: its components render as islands and their bundles are served, with
 * no restart.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "fs/promises";
import path from "path";
import { startDevServer, type DevServer } from "../support/dev-server";

const template = path.join(import.meta.dir, "../fixture-astro-renderers-retry");

let root = "";
let server: DevServer | null = null;
let BASE = "";

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(import.meta.dir, "../.renderers-retry-"));
  await fs.cp(template, root, { recursive: true });
  server = await startDevServer({ cwd: root, args: ["--no-restart"], timeoutMs: 25_000 });
  BASE = server.url;
}, 30_000);

afterAll(async () => {
  await server?.stop();
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
  expect({ html, output: server?.output() }).toMatchObject({ html: expect.stringContaining("preact 3</button>") });
  const island = html.match(/<astro-island [^>]*>/)?.[0] ?? "";
  expect(island).toContain('client="load"');
  const urls = [...island.matchAll(/ (component-url|renderer-url)="([^"]+)"/g)].map((match) => match[2]);
  expect(urls).toHaveLength(2);
  for (const url of urls) {
    const bundle = await fetch(`${BASE}${url}`);
    expect({ url, status: bundle.status }).toEqual({ url, status: 200 });
  }
}, 60_000);
