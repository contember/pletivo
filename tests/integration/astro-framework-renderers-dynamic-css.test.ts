/**
 * A framework component's `<style>` exists only in memory, compiled when the component loads. A
 * page restored from the incremental cache does not render, so a component its render imports
 * dynamically does not load: the cache entry keeps that CSS. A nested component is a dependency
 * of the page, so editing or deleting what it imports renders the page again.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "fs/promises";
import path from "path";

const root = path.join(import.meta.dir, "../fixture-astro-renderers-dynamic-css");
const cli = path.resolve(import.meta.dir, "../../packages/pletivo/src/cli.ts");
const dist = path.join(root, "dist");
const child = path.join(root, "src/components/Child.svelte");
const childCss = path.join(root, "vendor/child.css");
const originals = new Map<string, string>();

async function build(...flags: string[]): Promise<string> {
  const proc = Bun.spawn(["bun", cli, "build", ...flags], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const output = stdout + stderr;
  if ((await proc.exited) !== 0) throw new Error(`pletivo build ${flags.join(" ")} failed:\n${output}`);
  return output;
}

async function page(): Promise<string> {
  return await fs.readFile(path.join(dist, "index.html"), "utf8");
}

/** The page a full build of the same sources writes, which the warm build must equal. */
async function fullBuildPage(): Promise<string> {
  await build();
  return await page();
}

beforeEach(async () => {
  for (const file of [child, childCss]) originals.set(file, await fs.readFile(file, "utf8"));
  await build("--incremental", "--clean");
});

afterEach(async () => {
  for (const [file, text] of originals) await fs.writeFile(file, text);
  await fs.rm(dist, { recursive: true, force: true });
  await fs.rm(path.join(root, "node_modules"), { recursive: true, force: true });
});

test("a cached page keeps the CSS of framework components its render imported dynamically", async () => {
  const output = await build("--incremental");
  expect(output).toContain("0 rendered + 2 cached");
  const warm = await page();
  expect(warm).toMatch(/\.svelte-dyn\.svelte-[a-z0-9]+\{color:#151617\}/);
  expect(warm).toMatch(/\.svelte-child\.svelte-[a-z0-9]+\{color:#1f2021\}/);
  expect(warm).toContain(".vendor-child{color:#292a2b}");
  expect(warm).toBe(await fullBuildPage());
}, 120_000);

test("editing a nested component renders the page again, with its new markup and style", async () => {
  const source = originals.get(child) ?? "";
  await fs.writeFile(child, source.replace("child-v1", "child-v2").replace("rgb(31, 32, 33)", "rgb(51, 52, 53)"));
  const output = await build("--incremental");
  expect(output).toContain("1 rendered + 1 cached");
  const warm = await page();
  expect(warm).toContain("child-v2");
  expect(warm).toMatch(/\.svelte-child\.svelte-[a-z0-9]+\{color:#333435\}/);
  expect(warm).not.toContain("#1f2021");
  expect(warm).toBe(await fullBuildPage());
}, 120_000);

test("deleting a stylesheet a nested component imported does not break later warm builds", async () => {
  await fs.rm(childCss);
  await fs.writeFile(child, (originals.get(child) ?? "").replace(`import "../../vendor/child.css";`, ""));
  expect(await build("--incremental")).toContain("1 rendered + 1 cached");
  expect(await build("--incremental")).toContain("0 rendered + 2 cached");
  const warm = await page();
  expect(warm).not.toContain("vendor-child");
  expect(warm).toBe(await fullBuildPage());
}, 120_000);
