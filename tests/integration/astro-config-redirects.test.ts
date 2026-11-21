// `redirects` from the Astro config, as Astro's static build writes them. Built in its own process:
// the Astro host is set up once per process.
import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "fs/promises";
import path from "path";

const cli = path.resolve(import.meta.dir, "../../packages/pletivo/src/cli.ts");
const root = path.join(import.meta.dir, "../fixture-astro-redirects");
let output = "";
let exitCode = -1;

beforeAll(async () => {
  const child = Bun.spawn(["bun", cli, "build"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  output = stdout + stderr;
  exitCode = await child.exited;
}, 60_000);

afterAll(async () => {
  await fs.rm(path.join(root, "dist"), { recursive: true, force: true });
});

async function built(file: string): Promise<string> {
  if (exitCode !== 0) throw new Error(`build failed:\n${output}`);
  return Bun.file(path.join(root, "dist", file)).text();
}

test("a redirect is Astro's meta-refresh page; a 301 refreshes at once", async () => {
  expect(await built("old/index.html")).toBe(
    '<!doctype html><title>Redirecting to: /</title><meta http-equiv="refresh" content="0;url=/"><meta name="robots" content="noindex"><link rel="canonical" href="/"><body>\t<a href="/">Redirecting from <code>/old/</code> to <code>/</code></a></body>',
  );
});

test("the configured status applies to a destination naming a route; any other is a 301", async () => {
  expect(await built("moved/index.html")).toContain('<meta http-equiv="refresh" content="2;url=/about">');
  expect(await built("elsewhere/index.html")).toContain('<meta http-equiv="refresh" content="0;url=https://example.com/x">');
});

test("a redirect replaces the page of its route; a dynamic source is skipped with a warning", async () => {
  expect(await built("replaced/index.html")).toContain('content="0;url=/about"');
  expect(output).toContain("Skipping redirect /blog/[slug]");
  expect(await built("about/index.html")).toContain("<h1>About</h1>");
});
