/**
 * An MDX page in an Astro project renders as with `@astrojs/mdx`: heading ids, the module's
 * `components` export, a `<meta charset>` ahead of a page's content, and code blocks through
 * Astro's own highlighter, per `markdown.syntaxHighlight` and `markdown.shikiConfig`. The expected HTML is
 * what Astro 5.16.11 with `@astrojs/mdx` 4.3.13 builds from the same fixtures. A project
 * without an Astro config keeps pletivo's plain MDX. Each fixture builds in its own process:
 * the MDX options are set once per process.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";
import { resolveMdxOptions } from "../../packages/pletivo/src/mdx-plugin";
import { astroHighlightPlugins, parseShikiConfig, parseSyntaxHighlight } from "../../packages/pletivo/src/mdx-syntax-highlight";
import type { PletivoConfig } from "../../packages/pletivo/src/config";
import { normalizeAttributeSpelling, normalizeVoidElements } from "../astro-examples/compare";

const cli = path.resolve(import.meta.dir, "../../packages/pletivo/src/cli.ts");
type Fixture = "astro" | "compat" | "native" | "shiki" | "shikiTheme" | "shikiOff" | "prism";
const FIXTURES: Record<Fixture, string> = {
  astro: "fixture-astro-mdx-page",
  compat: "fixture-astro-mdx-page-compat",
  native: "fixture-mdx-page-native",
  shiki: "fixture-astro-mdx-shiki",
  shikiTheme: "fixture-astro-mdx-shiki-theme",
  shikiOff: "fixture-astro-mdx-shiki-off",
  prism: "fixture-astro-mdx-prism",
};
const NAMES: readonly Fixture[] = ["astro", "compat", "native", "shiki", "shikiTheme", "shikiOff", "prism"];

const fixtureRoot = (name: Fixture) => path.join(import.meta.dir, "..", FIXTURES[name]);

const builds = new Map<Fixture, { exitCode: number; output: string }>();

beforeAll(async () => {
  for (const name of NAMES) {
    const child = Bun.spawn(["bun", cli, "build"], { cwd: fixtureRoot(name), stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    builds.set(name, { exitCode: await child.exited, output: stdout + stderr });
  }
}, 120_000);

afterAll(async () => {
  for (const name of NAMES) {
    await fs.rm(path.join(fixtureRoot(name), "dist"), { recursive: true, force: true });
  }
});

async function page(name: Fixture, file: string): Promise<string> {
  const result = builds.get(name);
  if (result?.exitCode !== 0) throw new Error(`${name} failed to build:\n${result?.output}`);
  return Bun.file(path.join(fixtureRoot(name), "dist", file)).text();
}

/** Astro writes `<meta charset="utf-8"/>`, pletivo `<meta charset="utf-8">`: the harness normaliser makes them one. */
async function normalizedPage(name: Fixture, file: string): Promise<string> {
  return normalizeVoidElements(await page(name, file));
}

describe("an MDX page in an Astro project", () => {
  test("starts its content with <meta charset>", async () => {
    expect(await normalizedPage("astro", "index.html")).toStartWith('<meta charset="utf-8">\n<h1 ');
  });

  test("gets no <meta charset> when partial or led by a layout component, nor does MDX outside src/pages", async () => {
    expect(await page("astro", "partial/index.html")).toBe('<h1 id="partial">Partial</h1>');
    expect(await page("astro", "wrapped/index.html")).toBe(
      '<!DOCTYPE html>\n<html><head><title>Layout</title></head><body><h1 id="wrapped">Wrapped</h1></body></html>',
    );
    expect(await page("astro", "caller/index.html")).not.toContain("charset");
  });

  test("renders its elements through its components export, with Fragment provided, and ids on its headings", async () => {
    const content = (await normalizedPage("astro", "index.html")).replace('<meta charset="utf-8">\n', "");
    // `# Hello world!` renders through Title, which drops the id it is given. The fixture's
    // rehype plugin sets the `Preset` id before the heading ids run, which keep it.
    expect(content).toBe(
      [
        '<h1 class="title">Hello world!</h1>',
        '<h2 id="intro">Intro</h2>',
        '<h2 id="intro-1">Intro</h2>',
        '<h2 id="set-by-plugin">Preset</h2>',
        '<h2 id="step-1">Step 1 —</h2>',
        '<h2 id="total-1--1">Total 2</h2>',
        "<p>in a fragment</p>",
      ].join("\n"),
    );
  });

  test("a caller's components override the module's components export", async () => {
    const html = await page("astro", "caller/index.html");
    expect(html).toContain('<section id="own"><h2 class="sub">Snippet</h2></section>');
    expect(html).toContain('<section id="given"><h2 class="override">Snippet</h2></section>');
  });

  test("experimental.headingIdCompat keeps a slug's trailing dash", async () => {
    expect(await normalizedPage("compat", "index.html")).toBe('<meta charset="utf-8"><h2 id="step-1-">Step 1 —</h2>');
  });

  test("an experimental.headingIdCompat that is not a boolean is refused", () => {
    const config: PletivoConfig = { host: "localhost", port: 3000, base: "/", srcDir: "src", outDir: "dist", publicDir: "public" };
    const root = pathToFileURL(fixtureRoot("astro") + path.sep);
    const srcDir = new URL("src/", root);
    expect(() => resolveMdxOptions(config, { root, srcDir, experimental: { headingIdCompat: "yes" } })).toThrow(
      'experimental.headingIdCompat must be a boolean, got "yes"',
    );
  });
});

describe("an MDX page in a project without an Astro config", () => {
  test("keeps plain MDX: no charset, no heading ids, no components export, no highlighting", async () => {
    expect(await page("native", "index.html")).toBe('<h1>Hello world!</h1>\n<pre><code class="language-js">const answer = 42;\n</code></pre>');
  });
});

/** What Astro 5.16.11 with `@astrojs/mdx` 4.3.13 builds from the fixture, `<!DOCTYPE html>` left out. */
async function expectAstroOutput(name: Fixture, astro: string): Promise<void> {
  // `data-seen=""` and `&quot;` here, `data-seen` and `&#34;` in Astro's: the harness normaliser makes them one.
  const same = (html: string) => normalizeAttributeSpelling(normalizeVoidElements(html));
  expect(same(await page(name, "index.html"))).toBe(same(astro));
}

describe("a code block in an Astro project's MDX", () => {
  test("is highlighted by Astro's Shiki before the user's rehype plugins; math is left alone", async () => {
    // The fixture's rehype plugin marks a `<pre>` that is already highlighted with `data-seen`.
    await expectAstroOutput(
      "shiki",
      '<meta charset="utf-8"/><pre class="astro-code github-dark" style="background-color:#24292e;color:#e1e4e8;overflow-x:auto" tabindex="0" data-language="js" data-seen><code><span class="line"><span style="color:#F97583">const</span><span style="color:#79B8FF"> answer</span><span style="color:#F97583"> =</span><span style="color:#79B8FF"> 42</span><span style="color:#E1E4E8">;</span></span></code></pre>\n' +
        '<pre><code class="language-math">x^2\n</code></pre>\n' +
        '<pre class="astro-code github-dark" style="background-color:#24292e;color:#e1e4e8;overflow-x:auto" tabindex="0" data-language="plaintext" data-seen><code><span class="line"><span>plain text</span></span></code></pre>',
    );
  });

  test("follows markdown.shikiConfig and syntaxHighlight.excludeLangs", async () => {
    await expectAstroOutput(
      "shikiTheme",
      '<meta charset="utf-8"/><pre class="astro-code nord" style="background-color:#2e3440ff;color:#d8dee9ff;overflow-x:auto;white-space:pre-wrap;word-wrap:break-word" tabindex="0" data-language="js"><code><span class="line"><span style="color:#81A1C1">const</span><span style="color:#D8DEE9"> answer</span><span style="color:#81A1C1"> =</span><span style="color:#B48EAD"> 42</span><span style="color:#81A1C1">;</span></span></code></pre>\n' +
        '<pre><code class="language-text">left alone\n</code></pre>',
    );
  });

  test("is left as is with syntaxHighlight: false, its fence meta kept as metastring", async () => {
    await expectAstroOutput(
      "shikiOff",
      '<meta charset="utf-8"/><pre><code class="language-js" metastring="title=&#34;a/b.js&#34;">const answer = 42;\n</code></pre>',
    );
  });

  test("is highlighted by Astro's Prism with syntaxHighlight: \"prism\"", async () => {
    await expectAstroOutput(
      "prism",
      '<meta charset="utf-8"/><pre class="language-js" data-language="js"><code is:raw class="language-js"><span class="token keyword">const</span> answer <span class="token operator">=</span> <span class="token number">42</span><span class="token punctuation">;</span>\n</code></pre>',
    );
  });

  test("fails naming the package when astro or @astrojs/markdown-remark cannot be resolved", async () => {
    // Outside the repo, whose node_modules would resolve astro.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pletivo-highlight-"));
    try {
      await fs.mkdir(path.join(root, "none/node_modules"), { recursive: true });
      await fs.mkdir(path.join(root, "bare/node_modules/astro"), { recursive: true });
      await Bun.write(path.join(root, "bare/node_modules/astro/package.json"), '{"name":"astro","version":"0.0.0"}');
      await expect(astroHighlightPlugins(path.join(root, "none"), { type: "shiki" }, {})).rejects.toThrow(
        "MDX syntax highlighting uses the project's astro package, which cannot be resolved",
      );
      await expect(astroHighlightPlugins(path.join(root, "bare"), { type: "shiki" }, {})).rejects.toThrow(
        "MDX syntax highlighting uses @astrojs/markdown-remark, which cannot be resolved from the project's astro",
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("syntaxHighlight and shikiConfig are parsed as Astro's schema does", () => {
    expect(parseSyntaxHighlight(undefined, "m")).toEqual({ type: "shiki", excludeLangs: ["math"] });
    expect(parseSyntaxHighlight(false, "m")).toBe(false);
    expect(parseSyntaxHighlight("prism", "m")).toEqual({ type: "prism" });
    expect(parseSyntaxHighlight({ excludeLangs: ["sh"] }, "m")).toEqual({ type: "shiki", excludeLangs: ["sh"] });
    expect(() => parseSyntaxHighlight("highlightjs", "m")).toThrow('m.syntaxHighlight must be false, "shiki", "prism"');
    expect(() => parseSyntaxHighlight({ type: "shiki", excludeLangs: "sh" }, "m")).toThrow("m.syntaxHighlight must be");
    expect(() => parseShikiConfig("nord", "m")).toThrow('m.shikiConfig must be an object, got "nord"');
  });
});
