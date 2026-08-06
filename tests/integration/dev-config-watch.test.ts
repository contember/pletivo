import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "fs/promises";
import path from "path";
import { resolveConfigWatchFiles, watchConfigFiles } from "../../packages/pletivo/src/dev-config-watch";
import { _resetImportGraphForTests } from "../../packages/pletivo/src/incremental/import-graph";

const fixtureRoot = path.join(import.meta.dir, "__dev-config-watch-fixture__");

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("config watch set", () => {
  beforeAll(async () => {
    _resetImportGraphForTests();
    await fs.mkdir(path.join(fixtureRoot, "src"), { recursive: true });
    // astro.config.mjs → local integration → nested helper. A bare specifier
    // and a src/ file stand in for the things that must NOT be watched.
    await fs.writeFile(
      path.join(fixtureRoot, "astro.config.mjs"),
      [
        `import { defineConfig } from 'astro/config'`,
        `import integration from './my-integration.mjs'`,
        `export default defineConfig({ integrations: [integration()] })`,
        "",
      ].join("\n"),
    );
    await fs.writeFile(
      path.join(fixtureRoot, "my-integration.mjs"),
      [
        `import { helper } from './lib/helper.mjs'`,
        `export default function integration() { return { name: 'x', hooks: {} , helper } }`,
        "",
      ].join("\n"),
    );
    await fs.mkdir(path.join(fixtureRoot, "lib"), { recursive: true });
    await fs.writeFile(path.join(fixtureRoot, "lib/helper.mjs"), `export const helper = 1\n`);
    await fs.writeFile(path.join(fixtureRoot, "src/page.astro"), `<h1>hi</h1>\n`);
  });

  afterAll(async () => {
    _resetImportGraphForTests();
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  test("covers the config and everything it imports, transitively", async () => {
    const files = (await resolveConfigWatchFiles(fixtureRoot)).map((f) => path.relative(fixtureRoot, f));
    expect(files).toContain("astro.config.mjs");
    expect(files).toContain("my-integration.mjs");
    expect(files).toContain("lib/helper.mjs");
  });

  test("leaves src/ and bare specifiers to the other watchers", async () => {
    const files = (await resolveConfigWatchFiles(fixtureRoot)).map((f) => path.relative(fixtureRoot, f));
    expect(files.some((f) => f.startsWith("src/"))).toBe(false);
    expect(files.some((f) => f.includes("node_modules"))).toBe(false);
  });

  test("a project with no config file has nothing to watch", async () => {
    const empty = path.join(fixtureRoot, "empty");
    await fs.mkdir(empty, { recursive: true });
    expect(await resolveConfigWatchFiles(empty)).toEqual([]);
  });

  test("an edit to an imported module fires once, not per file", async () => {
    const files = await resolveConfigWatchFiles(fixtureRoot);
    const seen: string[] = [];
    const watcher = watchConfigFiles(files, (file) => seen.push(path.basename(file)));
    try {
      await fs.writeFile(path.join(fixtureRoot, "lib/helper.mjs"), `export const helper = 2\n`);
      await fs.writeFile(path.join(fixtureRoot, "my-integration.mjs"), `export default function i() {}\n`);
      await wait(400);
      expect(seen).toHaveLength(1);
    } finally {
      watcher.close();
    }
  });

  test("a closed watcher stops firing", async () => {
    const files = await resolveConfigWatchFiles(fixtureRoot);
    const seen: string[] = [];
    const watcher = watchConfigFiles(files, (file) => seen.push(file));
    watcher.close();
    await fs.writeFile(path.join(fixtureRoot, "lib/helper.mjs"), `export const helper = 3\n`);
    await wait(300);
    expect(seen).toEqual([]);
  });
});
