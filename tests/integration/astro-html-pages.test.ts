// `.html` components and pages in an Astro project, as Astro builds them. Built in its own
// process: the `.html` loader registers once per process, and only for an Astro project.
import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "fs/promises";
import path from "path";

const cli = path.resolve(import.meta.dir, "../../packages/pletivo/src/cli.ts");
const root = path.join(import.meta.dir, "../fixture-astro-html");
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

test("an .html component renders its text with the slots passed, or their fallbacks", async () => {
  expect(await built("index.html")).toBe('<!DOCTYPE html><div id="default">Fallback</div><div id="a"><span>A</span></div>\n');
});

test("an .html page is a route, its text verbatim; 404.html is the 404 page", async () => {
  expect(await built("plain/index.html")).toBe("<!DOCTYPE html><h1>Plain ${page}</h1>\n");
  expect(await built("404.html")).toBe("<!DOCTYPE html><h1>Not here</h1>\n");
});
