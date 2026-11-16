/**
 * No host applies a `.md` page's `layout:` frontmatter yet. Rendering the page
 * without it ships a page with no `<html lang>`, no `<head>` from the layout and
 * no shell, so build and prepare refuse it by name. A content-collection entry
 * with a `layout` field is plain data and must keep building.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import fs from "fs/promises";
import path from "path";
import { build } from "../../packages/pletivo/src/build";
import { __resetForTests } from "../../packages/pletivo/src/astro-host/runner";
import type { PletivoConfig } from "../../packages/pletivo/src/config";
import { PrepareError, prepare } from "../../packages/pletivo/src/prepare/index";

const fixtureRoot = path.join(import.meta.dir, "../fixture-md-page-layout");
const temporaryDirectories: string[] = [];

const config: PletivoConfig = {
  host: "localhost",
  outDir: "dist",
  port: 3000,
  base: "/",
  srcDir: "src",
  publicDir: "public",
};

afterEach(() => {
  __resetForTests();
});

afterAll(async () => {
  await fs.rm(path.join(fixtureRoot, "dist"), { recursive: true, force: true });
  await Promise.all(temporaryDirectories.map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

/** The fixture without its `.md` page: only the collection entry carries `layout`. */
async function withoutMarkdownPage(): Promise<string> {
  // Inside the repo, so `astro:content` and `astro/loaders` resolve as for the fixture.
  const directory = await fs.mkdtemp(path.join(import.meta.dir, "tmp-md-page-layout-"));
  temporaryDirectories.push(directory);
  await fs.cp(fixtureRoot, directory, { recursive: true });
  await fs.rm(path.join(directory, "src/pages/about.md"));
  await fs.rm(path.join(directory, "dist"), { recursive: true, force: true });
  return directory;
}

async function preparedError(root: string): Promise<PrepareError> {
  try {
    await prepare(root);
  } catch (error) {
    if (error instanceof PrepareError) return error;
    throw error;
  }
  throw new Error(`Expected prepare to fail for ${root}`);
}

describe(".md page with layout: frontmatter", () => {
  test("build fails and names the page and `layout:`", async () => {
    await expect(build(fixtureRoot, config)).rejects.toThrow(
      "src/pages/about.md: `layout:` in frontmatter is not supported by pletivo yet",
    );
  });

  test("prepare refuses the page with a fatal diagnostic", async () => {
    const error = await preparedError(fixtureRoot);
    expect(error.diagnostics).toEqual([
      {
        source: "src/pages/about.md",
        hook: "layout",
        reason: expect.stringContaining("`layout:` in frontmatter is not supported by pletivo yet"),
      },
    ]);
  });

  test("a collection entry with a layout field still builds", async () => {
    const root = await withoutMarkdownPage();
    await build(root, config);
    const html = await Bun.file(path.join(root, "dist/posts/index.html")).text();
    expect(html).toContain('data-layout="wide"');
    expect(html).toContain("Collection body text.");
  });

  test("a collection entry with a layout field passes prepare", async () => {
    const root = await withoutMarkdownPage();
    await expect(prepare(root)).resolves.toBeDefined();
  });
});
