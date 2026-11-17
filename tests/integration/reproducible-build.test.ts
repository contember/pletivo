/**
 * The same project built from two checkouts gives the same `dist/`, file names included.
 * Each copy builds in its own `pletivo build` process, from its own directory, as a user runs it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "fs/promises";
import os from "os";
import path from "path";

const cli = path.resolve(import.meta.dir, "../../packages/pletivo/src/cli.ts");
const testsDir = path.resolve(import.meta.dir, "..");

const checkouts: string[] = [];

/** Copies `fixture` into a new directory under `parent`, builds it there and returns its `dist/` files. */
async function buildCheckout(fixture: string, parent: string, prefix: string): Promise<Map<string, Uint8Array>> {
  const root = await fs.mkdtemp(path.join(parent, prefix));
  checkouts.push(root);
  await fs.cp(fixture, root, { recursive: true, filter: (source) => !source.startsWith(path.join(fixture, "dist")) });
  const child = Bun.spawn([process.execPath, cli, "build"], { cwd: root, stdout: "pipe", stderr: "pipe" });
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

/** Every file in `a` has the same contents in `b`, after `normalize`. */
function expectSameContents(
  a: Map<string, Uint8Array>,
  b: Map<string, Uint8Array>,
  normalize: (name: string, bytes: Uint8Array) => Uint8Array = (_name, bytes) => bytes,
): void {
  for (const [name, bytes] of a) {
    const other = b.get(name) ?? new Uint8Array();
    const same = Buffer.from(normalize(name, bytes)).equals(Buffer.from(normalize(name, other)));
    expect({ name, same }).toEqual({ name, same: true });
  }
}

afterAll(async () => {
  for (const root of checkouts) await fs.rm(root, { recursive: true, force: true });
});

describe("hoisted scripts", () => {
  // Hoisted scripts in a page and in a component, linked as files rather than inlined.
  const fixture = path.join(testsDir, "fixture-astro-inline-scripts-limit-zero");
  const built: Map<string, Uint8Array>[] = [];

  beforeAll(async () => {
    // Locations differ in name and length, so a path anywhere in an output name or byte shows.
    built.push(await buildCheckout(fixture, os.tmpdir(), "pletivo-repro-a-"));
    built.push(await buildCheckout(fixture, os.tmpdir(), "pletivo-reproducible-build-checkout-b-"));
  }, 120_000);

  test("hoisted scripts keep their file names", () => {
    const [a, b] = built;
    const hoisted = [...a.keys()].filter((name) => /^_astro\/hoisted-[a-f0-9]+\.js$/.test(name));
    expect(hoisted).toHaveLength(2);
    expect([...b.keys()]).toEqual([...a.keys()]);
  });

  test("every output file is byte-identical", () => {
    const [a, b] = built;
    expectSameContents(a, b);
  });
});

describe("framework islands", () => {
  // Preact, React, Solid, Svelte and Vue islands on one page.
  const fixture = path.join(testsDir, "fixture-astro-renderers-multi");
  const built: Map<string, Uint8Array>[] = [];
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const componentUrls = (files: Map<string, Uint8Array>): string[] =>
    [...decoder.decode(files.get("index.html")).matchAll(/<astro-island\s[^>]*?\bcomponent-url="([^"]+)"/g)].map((match) => match[1]);

  // The island `uid` hashes the absolute component path, as Astro's does (docs/todos/025); only it is masked.
  const withoutUid = (name: string, bytes: Uint8Array): Uint8Array =>
    name.endsWith(".html") ? encoder.encode(decoder.decode(bytes).replace(/ uid="[^"]*"/g, ' uid=""')) : bytes;

  beforeAll(async () => {
    // Inside `tests/`, so the integrations resolve from the repo's `node_modules`.
    built.push(await buildCheckout(fixture, testsDir, ".repro-a-"));
    built.push(await buildCheckout(fixture, testsDir, ".reproducible-build-checkout-b-"));
  }, 120_000);

  test("island entries keep their file names and component URLs", () => {
    const [a, b] = built;
    const urls = componentUrls(a);
    expect(urls).toHaveLength(5);
    for (const url of urls) {
      expect(url).toMatch(/^\/_astro\/\w+Counter\.[\w-]{8}\.js$/);
      expect(a.has(url.slice(1))).toBe(true);
    }
    expect(componentUrls(b)).toEqual(urls);
    expect([...b.keys()]).toEqual([...a.keys()]);
  });

  test("every output file is identical, island uid aside", () => {
    const [a, b] = built;
    expectSameContents(a, b, withoutUid);
  });
});
