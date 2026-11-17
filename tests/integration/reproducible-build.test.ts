/**
 * The same project built from two checkouts gives the same `dist/`, file names included.
 * Each copy builds in its own `pletivo build` process, from its own directory, as a user runs it.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "fs/promises";
import os from "os";
import path from "path";

const cli = path.resolve(import.meta.dir, "../../packages/pletivo/src/cli.ts");
// Hoisted scripts in a page and in a component, linked as files rather than inlined.
const fixture = path.join(import.meta.dir, "../fixture-astro-inline-scripts-limit-zero");

const checkouts: string[] = [];
const built: Map<string, Uint8Array>[] = [];

async function buildCheckout(prefix: string): Promise<Map<string, Uint8Array>> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  checkouts.push(root);
  await fs.cp(fixture, root, { recursive: true, filter: (source) => !source.startsWith(path.join(fixture, "dist")) });
  const child = Bun.spawn(["bun", cli, "build"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ exit: await child.exited, output: stdout + stderr }).toMatchObject({ exit: 0 });
  const distDir = path.join(root, "dist");
  const files = new Map<string, Uint8Array>();
  for (const name of (await fs.readdir(distDir, { recursive: true })).sort()) {
    const file = path.join(distDir, name);
    if ((await fs.stat(file)).isFile()) files.set(name, new Uint8Array(await fs.readFile(file)));
  }
  return files;
}

beforeAll(async () => {
  // Locations differ in name and length, so a path anywhere in an output name or byte shows.
  built.push(await buildCheckout("pletivo-repro-a-"));
  built.push(await buildCheckout("pletivo-reproducible-build-checkout-b-"));
}, 120_000);

afterAll(async () => {
  for (const root of checkouts) await fs.rm(root, { recursive: true, force: true });
});

test("hoisted scripts keep their file names", () => {
  const [a, b] = built;
  const hoisted = [...a.keys()].filter((name) => /^_astro\/hoisted-[a-f0-9]+\.js$/.test(name));
  expect(hoisted).toHaveLength(2);
  expect([...b.keys()]).toEqual([...a.keys()]);
});

test("every output file is byte-identical", () => {
  const [a, b] = built;
  for (const [name, bytes] of a) {
    expect({ name, same: Buffer.from(bytes).equals(Buffer.from(b.get(name) ?? new Uint8Array())) }).toEqual({
      name,
      same: true,
    });
  }
});
