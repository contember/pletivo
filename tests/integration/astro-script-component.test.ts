// An `.astro` component imported by a page's `<script>`, as Astro's client build bundles it: an
// empty module. Built in its own process: the Astro host is set up once per process.
import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "fs/promises";
import path from "path";

const cli = path.resolve(import.meta.dir, "../../packages/pletivo/src/cli.ts");
const root = path.join(import.meta.dir, "../fixture-astro-script-component");
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

test("a component imported in browser code is an empty object, not its file's URL", async () => {
  if (exitCode !== 0) throw new Error(`build failed:\n${output}`);
  const html = await Bun.file(path.join(root, "dist/index.html")).text();
  expect(html).toContain("<p>Server only</p>");
  expect(html).toMatch(/<script type="module">var (\w+)=\{\};console\.log\("card",\1\);<\/script>/);
  expect(html).not.toContain(".astro");
});
