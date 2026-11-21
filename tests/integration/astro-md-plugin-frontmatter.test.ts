// Remark plugins add to a Markdown file's frontmatter through `file.data.astro.frontmatter`, as in
// Astro. Built in its own process: markdown options are set once per process.
import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "fs/promises";
import path from "path";

const cli = path.resolve(import.meta.dir, "../../packages/pletivo/src/cli.ts");
const root = path.join(import.meta.dir, "../fixture-astro-md-frontmatter");
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

test("a .md page's layout gets the frontmatter the plugins left", async () => {
  expect(await built("page/index.html")).toContain('<p id="layout">injected into Page</p>');
});

test("render(entry) returns it as remarkPluginFrontmatter, and the entry's data stays as validated", async () => {
  const html = await built("entry/index.html");
  expect(html).toContain('<p id="entry">injected into Entry</p>');
  expect(html).toContain('<p id="data">undefined</p>');
  expect(html).toContain("<p>Entry body.</p>");
});
