/**
 * A `.md` page renders through its module, inside the layout its `layout:` frontmatter
 * names, with the layout's CSS and scripts; `--incremental` re-renders it when the layout
 * changes. An `.mdx` page's `layout:` is still not applied, so build refuses it by name.
 * A content-collection entry or an imported `.mdx` with a `layout` field is plain data.
 */
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import fs from "fs/promises";
import path from "path";
import { build } from "../../packages/pletivo/src/build";
import { __resetForTests } from "../../packages/pletivo/src/astro-host/runner";
import type { PletivoConfig } from "../../packages/pletivo/src/config";
import { prepare } from "../../packages/pletivo/src/prepare/index";

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

const MDX_PAGE = "src/pages/guide.mdx";

/** A copy of the fixture without the given pages. */
async function fixtureWithout(...pages: string[]): Promise<string> {
  // Inside the repo, so `astro:content` and `astro/loaders` resolve as for the fixture.
  const directory = await fs.mkdtemp(path.join(import.meta.dir, "tmp-md-page-layout-"));
  temporaryDirectories.push(directory);
  await fs.cp(fixtureRoot, directory, { recursive: true });
  await Promise.all(pages.map((page) => fs.rm(path.join(directory, page))));
  await fs.rm(path.join(directory, "dist"), { recursive: true, force: true });
  return directory;
}

const cli = path.resolve(import.meta.dir, "../../packages/pletivo/src/cli.ts");

async function cliBuild(root: string, ...flags: string[]): Promise<string> {
  const child = Bun.spawn(["bun", cli, "build", ...flags], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const output = stdout + stderr;
  if ((await child.exited) !== 0) throw new Error(`pletivo build ${flags.join(" ")} failed:\n${output}`);
  return output;
}

async function built(root: string, page: string): Promise<string> {
  return await Bun.file(path.join(root, "dist", page, "index.html")).text();
}

/** The page's CSS: inline `<style>` blocks and the stylesheets it links. */
async function pageCss(root: string, html: string): Promise<string> {
  const inline = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((match) => match[1]);
  const linked = await Promise.all(
    [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map((match) =>
      Bun.file(path.join(root, "dist", match[1])).text(),
    ),
  );
  return [...inline, ...linked].join("\n");
}

/** The page's scripts: inline bodies and the modules it loads. */
async function pageScripts(root: string, html: string): Promise<string> {
  const inline = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  const loaded = await Promise.all(
    [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) => Bun.file(path.join(root, "dist", match[1])).text()),
  );
  return [...inline, ...loaded].join("\n");
}

describe(".md page with layout: frontmatter", () => {
  test("renders inside its layout, with the layout's props", async () => {
    const root = await fixtureWithout(MDX_PAGE);
    await build(root, config);
    const html = await built(root, "about");
    expect(html).toStartWith("<!DOCTYPE html>");
    expect(html).toContain('<html lang="en"');
    expect(html).toContain("<title>About</title>");
    expect(html).toMatch(/<span class="badge" data-astro-cid-[a-z0-9]+>md<\/span>/);
    expect(html).toContain('<main class="shell" data-url="/about" data-astro-cid-');
    expect(html).toContain("<p>A Markdown page inside its layout.</p></main>");
  });

  test("carries the layout's scoped style, its imported stylesheet and its script", async () => {
    const root = await fixtureWithout(MDX_PAGE);
    await build(root, config);
    const html = await built(root, "about");
    const css = await pageCss(root, html);
    expect(css).toMatch(/\.shell\[data-astro-cid-[a-z0-9]+\]\{color:rgb\(1,2,3\)\}/);
    expect(css).toContain("body{background:#040506}");
    expect(await pageScripts(root, html)).toContain('dataset.mdLayout="ran"');
  });

  test("orders the layout's CSS as Astro does: an imported component's before the layout's own", async () => {
    const root = await fixtureWithout(MDX_PAGE);
    await build(root, config);
    const css = await pageCss(root, await built(root, "about"));
    expect(css.indexOf("color:rgb(7,8,9)")).toBeGreaterThan(-1);
    expect(css.indexOf("color:rgb(7,8,9)")).toBeLessThan(css.indexOf("color:rgb(1,2,3)"));
  });

  test("keeps that order when an .astro page imports the .md", async () => {
    const root = await fixtureWithout(MDX_PAGE);
    await fs.writeFile(
      path.join(root, "src/pages/wrapped.astro"),
      '---\nimport { Content } from "./about.md";\n---\n<Content />\n',
    );
    await build(root, config);
    const css = await pageCss(root, await built(root, "wrapped"));
    expect(css.indexOf("color:rgb(7,8,9)")).toBeGreaterThan(-1);
    expect(css.indexOf("color:rgb(7,8,9)")).toBeLessThan(css.indexOf("color:rgb(1,2,3)"));
  });

  test("links a package stylesheet its layout imports on its page only", async () => {
    const root = await fixtureWithout(MDX_PAGE);
    for (const [name, color] of [["md-theme", "rgb(11, 11, 11)"], ["other-theme", "rgb(12, 12, 12)"]]) {
      await fs.mkdir(path.join(root, "node_modules", name), { recursive: true });
      await fs.writeFile(path.join(root, "node_modules", name, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
      await fs.writeFile(path.join(root, "node_modules", name, "theme.css"), `.${name} { color: ${color}; }\n`);
    }
    const layout = path.join(root, "src/layouts/Base.astro");
    await fs.writeFile(layout, (await fs.readFile(layout, "utf8")).replace("---\n", '---\nimport "md-theme/theme.css";\n'));
    await fs.writeFile(
      path.join(root, "src/pages/other.astro"),
      '---\nimport "other-theme/theme.css";\n---\n<html><head><title>Other</title></head><body><p>other</p></body></html>\n',
    );
    await build(root, config);
    const sheets = async (page: string) => {
      const css = await pageCss(root, await built(root, page));
      return { md: css.includes(".md-theme{"), other: css.includes(".other-theme{") };
    };
    expect(await sheets("about")).toEqual({ md: true, other: false });
    expect(await sheets("plain")).toEqual({ md: false, other: false });
    expect(await sheets("other")).toEqual({ md: false, other: true });
  });

  test("resolves a root-relative layout path", async () => {
    const root = await fixtureWithout(MDX_PAGE);
    await fs.writeFile(
      path.join(root, "src/pages/rooted.md"),
      "---\ntitle: Rooted\nlayout: /src/layouts/Base.astro\n---\n\nRooted body.\n",
    );
    await build(root, config);
    const html = await built(root, "rooted");
    expect(html).toContain('<html lang="en"');
    expect(html).toContain("<p>Rooted body.</p>");
  });

  test("a page without a layout keeps the minimal document", async () => {
    const root = await fixtureWithout(MDX_PAGE);
    await build(root, config);
    expect(await built(root, "plain")).toStartWith(
      '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Plain</title>',
    );
    expect(await built(root, "plain")).toContain("<body><p>A Markdown page without a layout.</p></body></html>");
  });

  test("an incremental build re-renders the page when its layout changes, and only it", async () => {
    const root = await fixtureWithout(MDX_PAGE);
    // A process per build, as `pletivo build` runs: one process keeps the old layout module loaded.
    await cliBuild(root, "--incremental");
    expect(await built(root, "about")).toContain('<html lang="en"');

    const layout = path.join(root, "src/layouts/Base.astro");
    await fs.writeFile(layout, (await fs.readFile(layout, "utf8")).replace('<html lang="en"', '<html lang="cs"'));
    const output = await cliBuild(root, "--incremental");
    expect(output).toContain("1 rendered + 2 cached");
    expect(output).toMatch(/about\.md → dist\/about\/index\.html \(\d+ B\)\n/);
    expect(output).toMatch(/plain\.md → dist\/plain\/index\.html \(\d+ B\) \[cached\]/);
    const html = await built(root, "about");
    expect(html).toContain('<html lang="cs"');
    expect(html).toContain("<p>A Markdown page inside its layout.</p>");
    expect(await pageCss(root, html)).toContain("body{background:#040506}");
  });

  test("build names a .md page whose layout: is not a path", async () => {
    const root = await fixtureWithout(MDX_PAGE);
    await fs.writeFile(path.join(root, "src/pages/bad.md"), "---\nlayout: 3\n---\n\nBody.\n");
    await expect(build(root, config)).rejects.toThrow("src/pages/bad.md: `layout:` in frontmatter must be a path");
  });

  test("gives the layout the url in the trailingSlash form", async () => {
    const root = await fixtureWithout(MDX_PAGE);
    await fs.writeFile(path.join(root, "astro.config.mjs"), 'export default { trailingSlash: "always" };\n');
    await build(root, config);
    expect(await built(root, "about")).toContain('data-url="/about/"');
  });

  test("an import with ?raw gets the file's text, not the module", async () => {
    const root = await fixtureWithout(MDX_PAGE);
    await fs.writeFile(
      path.join(root, "src/pages/source.astro"),
      '---\nimport text from "./about.md?raw";\n---\n<pre>{text.trim()}</pre>\n',
    );
    await build(root, config);
    expect(await built(root, "source")).toContain("<pre>---\ntitle: About\nlayout: ../layouts/Base.astro\n---");
  });

  test("prepare accepts it", async () => {
    const root = await fixtureWithout(MDX_PAGE);
    await expect(prepare(root)).resolves.toBeDefined();
  });
});

describe(".mdx page with layout: frontmatter", () => {
  test("build fails on a .mdx page, names it and `layout:`, and offers wrapping", async () => {
    const result = build(await fixtureWithout(), config);
    await expect(result).rejects.toThrow(
      "src/pages/guide.mdx: `layout:` in frontmatter is not supported by pletivo yet",
    );
    await expect(result).rejects.toThrow("import the layout and wrap the content in it");
  });

  test("build names a .mdx page whose frontmatter is not valid YAML", async () => {
    const root = await fixtureWithout(MDX_PAGE);
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
    const root = await fixtureWithout(MDX_PAGE);
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
});

describe("a layout field that is data, not a page's layout", () => {
  test("a collection entry and an imported .mdx with a layout field still build", async () => {
    const root = await fixtureWithout(MDX_PAGE);
    await build(root, config);
    const html = await built(root, "posts");
    expect(html).toContain('data-layout="wide"');
    expect(html).toContain("Collection body text.");
    expect(html).toContain("Imported MDX note text.");
  });

  test("prepare does not vendor a package a collection entry's layout field happens to name", async () => {
    const root = await fixtureWithout(MDX_PAGE);
    // A package the Workers graph cannot carry: vendoring it would fail prepare.
    await fs.mkdir(path.join(root, "node_modules/wide"), { recursive: true });
    await fs.writeFile(path.join(root, "node_modules/wide/package.json"), '{ "name": "wide", "main": "index.cjs" }\n');
    await fs.writeFile(path.join(root, "node_modules/wide/index.cjs"), "module.exports = {};\n");
    await expect(prepare(root)).resolves.toBeDefined();
  });

  test("a _-prefixed .md under src/pages is not a page, so its layout field passes build and prepare", async () => {
    const root = await fixtureWithout(MDX_PAGE);
    await fs.mkdir(path.join(root, "src/pages/_drafts"));
    await fs.writeFile(path.join(root, "src/pages/_drafts/next.md"), "---\nlayout: ../../layouts/Missing.astro\n---\n\nDraft.\n");
    await build(root, config);
    expect(await Bun.file(path.join(root, "dist/_drafts/next/index.html")).exists()).toBe(false);
    __resetForTests();
    await expect(prepare(root)).resolves.toBeDefined();
  });
});
