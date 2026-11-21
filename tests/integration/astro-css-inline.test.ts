// Vite's `?inline` and `?raw` CSS imports in an Astro project, as Astro builds them. Built in its
// own process: the Astro loader plugins register once per process.
import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "fs/promises";
import path from "path";

const cli = path.resolve(import.meta.dir, "../../packages/pletivo/src/cli.ts");
const root = path.join(import.meta.dir, "../fixture-astro-css-inline");
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

test("a `?inline` CSS import is the minified stylesheet text, a `?raw` one the file's text", async () => {
  if (exitCode !== 0) throw new Error(`build failed:\n${output}`);
  const html = await Bun.file(path.join(root, "dist", "index.html")).text();
  expect(html).toContain('<p id="inline">body{background:tomato}</p>');
  expect(html).toContain('<p id="raw">main {\n  background: plum;\n}\n</p>');
});
