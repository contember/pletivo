/**
 * A framework component's `<style>` exists only in memory, compiled when the component loads. A
 * page restored from the incremental cache does not render, so a component its render imports
 * dynamically does not load: the cache entry keeps that CSS.
 */
import { afterAll, expect, test } from "bun:test";
import fs from "fs/promises";
import path from "path";

const root = path.join(import.meta.dir, "../fixture-astro-renderers-dynamic-css");
const cli = path.resolve(import.meta.dir, "../../packages/pletivo/src/cli.ts");
const dist = path.join(root, "dist");

async function build(...flags: string[]): Promise<string> {
  const child = Bun.spawn(["bun", cli, "build", ...flags], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const output = stdout + stderr;
  if ((await child.exited) !== 0) throw new Error(`pletivo build ${flags.join(" ")} failed:\n${output}`);
  return output;
}

afterAll(async () => {
  await fs.rm(dist, { recursive: true, force: true });
});

test("a cached page keeps the CSS of a framework component its render imported dynamically", async () => {
  await build("--incremental", "--clean");
  const output = await build("--incremental");
  expect(output).toContain("0 rendered + 2 cached");
  const warm = await fs.readFile(path.join(dist, "index.html"), "utf8");
  expect(warm).toMatch(/\.svelte-dyn\.svelte-[a-z0-9]+\{color:#151617\}/);

  await build();
  expect(await fs.readFile(path.join(dist, "index.html"), "utf8")).toBe(warm);
}, 120_000);
