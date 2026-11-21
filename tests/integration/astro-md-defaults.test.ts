// A `.md` page in an Astro project renders with `@astrojs/markdown-remark`'s defaults: smartypants,
// and Shiki before the user's rehype plugins. Built in its own process: markdown options are set once per process.
import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "fs/promises";
import path from "path";

const cli = path.resolve(import.meta.dir, "../../packages/pletivo/src/cli.ts");
const root = path.join(import.meta.dir, "../fixture-astro-md-defaults");
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

test("a .md page gets curly quotes, dashes and ellipses, and Shiki before the user's rehype plugins", async () => {
  if (exitCode !== 0) throw new Error(`build failed:\n${output}`);
  const html = await Bun.file(path.join(root, "dist/index.html")).text();
  expect(html).toContain("<p>“Smartypants” is — awesome…</p>");
  // Astro's `.md` markup, unlike MDX's: its style keeps Shiki's spacing, and `data-seen` gets a value.
  expect(html).toContain(
    '<pre class="astro-code github-dark" style="background-color:#24292e;color:#e1e4e8; overflow-x: auto;" tabindex="0" data-language="js" data-seen="">',
  );
});
