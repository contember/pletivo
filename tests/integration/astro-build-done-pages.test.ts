// The page names `astro:build:done` gets, as Astro's `addPageName` gives them: the route path,
// with a trailing slash only where trailingSlash and build.format ask for one, whatever file the
// page went to. Built in its own process: the Astro host is set up once per process.
import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "fs/promises";
import path from "path";

const cli = path.resolve(import.meta.dir, "../../packages/pletivo/src/cli.ts");
const root = path.join(import.meta.dir, "../fixture-astro-build-done-pages");
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

test("build.format file names a page by its route, not its .html file", async () => {
  if (exitCode !== 0) throw new Error(`build failed:\n${output}`);
  expect(await Bun.file(path.join(root, "dist/about.html")).exists()).toBe(true);
  expect(await Bun.file(path.join(root, "dist/pages.json")).json()).toEqual(["", "500", "about"]);
});
