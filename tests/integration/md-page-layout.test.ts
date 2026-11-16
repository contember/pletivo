/**
 * No host applies a `.md`/`.mdx` page's `layout:` frontmatter yet. Rendering the
 * page without it ships a page with no `<html lang>`, no `<head>` from the layout
 * and no shell, so build and prepare refuse it by name. A content-collection entry
 * or an imported `.mdx` with a `layout` field is plain data and must keep building.
 */
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
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

const MD_PAGE = "src/pages/about.md";
const MDX_PAGE = "src/pages/guide.mdx";

/** A copy of the fixture without the given pages, so each refusal is tested alone. */
async function fixtureWithout(...pages: string[]): Promise<string> {
  // Inside the repo, so `astro:content` and `astro/loaders` resolve as for the fixture.
  const directory = await fs.mkdtemp(path.join(import.meta.dir, "tmp-md-page-layout-"));
  temporaryDirectories.push(directory);
  await fs.cp(fixtureRoot, directory, { recursive: true });
  await Promise.all(pages.map((page) => fs.rm(path.join(directory, page))));
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

describe(".md/.mdx page with layout: frontmatter", () => {
  test("build fails on a .md page and names it and `layout:`", async () => {
    await expect(build(await fixtureWithout(MDX_PAGE), config)).rejects.toThrow(
      "src/pages/about.md: `layout:` in frontmatter is not supported by pletivo yet",
    );
  });

  test("build fails on a .mdx page, names it and `layout:`, and offers wrapping", async () => {
    const result = build(await fixtureWithout(MD_PAGE), config);
    await expect(result).rejects.toThrow(
      "src/pages/guide.mdx: `layout:` in frontmatter is not supported by pletivo yet",
    );
    await expect(result).rejects.toThrow("import the layout and wrap the content in it");
  });

  test("build names a .mdx page whose frontmatter is not valid YAML", async () => {
    const root = await fixtureWithout(MD_PAGE, MDX_PAGE);
    await fs.writeFile(path.join(root, "src/pages/bad.mdx"), "---\ntitle: [unclosed\n---\n\nBody.\n");
    const error = await build(root, config).then(
      () => null,
      (rejection: unknown) => rejection,
    );
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("src/pages/bad.mdx: invalid frontmatter:");
    expect(error instanceof Error && error.cause instanceof Error).toBe(true);
  });

  test("build does not emit an injected .mdx route with `layout:` and names it", async () => {
    const root = await fixtureWithout(MD_PAGE, MDX_PAGE);
    await fs.mkdir(path.join(root, "src/routes"));
    await fs.writeFile(
      path.join(root, "src/routes/injected.mdx"),
      "---\nlayout: ../layouts/Base.astro\n---\n\nInjected MDX body.\n",
    );
    await fs.writeFile(
      path.join(root, "astro.config.mjs"),
      `import { defineConfig } from "astro/config";

export default defineConfig({
  integrations: [{
    name: "inject-layout-mdx",
    hooks: {
      "astro:config:setup": ({ injectRoute }) => {
        injectRoute({ pattern: "/injected-guide", entrypoint: "./src/routes/injected.mdx" });
      },
    },
  }],
});
`,
    );
    const logged = spyOn(console, "error");
    try {
      await build(root, config);
      const messages = logged.mock.calls.map((call) => call.map(String).join(" "));
      expect(messages.some((message) => message.includes(
        "src/routes/injected.mdx: `layout:` in frontmatter is not supported by pletivo yet",
      ))).toBe(true);
    } finally {
      logged.mockRestore();
    }
    expect(await Bun.file(path.join(root, "dist/injected-guide/index.html")).exists()).toBe(false);
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

  test("a collection entry and an imported .mdx with a layout field still build", async () => {
    const root = await fixtureWithout(MD_PAGE, MDX_PAGE);
    await build(root, config);
    const html = await Bun.file(path.join(root, "dist/posts/index.html")).text();
    expect(html).toContain('data-layout="wide"');
    expect(html).toContain("Collection body text.");
    expect(html).toContain("Imported MDX note text.");
  });

  test("a collection entry with a layout field passes prepare", async () => {
    const root = await fixtureWithout(MD_PAGE, MDX_PAGE);
    await expect(prepare(root)).resolves.toBeDefined();
  });
});
