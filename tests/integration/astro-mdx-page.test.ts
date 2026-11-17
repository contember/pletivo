// MDX in an Astro project renders as Astro 5.16.11 with `@astrojs/mdx` 4.3.13 builds the same
// fixtures; without an Astro config pletivo's plain MDX stays. Each fixture builds in its own
// process, since the MDX options are set once per process.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";
import { resolveMdxOptions } from "../../packages/pletivo/src/mdx-plugin";
import {
  parseMdxShikiConfig,
  parseMdxSyntaxHighlight,
  parseShikiConfig,
  parseSyntaxHighlight,
} from "../../packages/pletivo/src/mdx-syntax-highlight";
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
    expect(await normalizedPage("astro", "index.html")).toStartWith('<!DOCTYPE html><meta charset="utf-8">\n<h1 ');
  });

  test("gets no <meta charset> when partial, led by a layout component, outside src/pages or _-prefixed", async () => {
    expect(await page("astro", "partial/index.html")).toBe('<h1 id="partial">Partial</h1>');
    expect(await page("astro", "wrapped/index.html")).toBe(
      '<!DOCTYPE html><html><head><title>Layout</title></head><body><h1 id="wrapped">Wrapped</h1></body></html>',
    );
    const caller = await page("astro", "caller/index.html");
    expect(caller).not.toContain("charset");
    expect(caller).toContain('<section id="underscored"><h2 id="underscored">Underscored</h2>');
  });

  test("renders its elements through its components export, with Fragment provided, and ids on its headings", async () => {
    const content = (await normalizedPage("astro", "index.html")).replace('<!DOCTYPE html><meta charset="utf-8">\n', "");
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
    expect(await normalizedPage("compat", "index.html")).toBe('<!DOCTYPE html><meta charset="utf-8"><h2 id="step-1-">Step 1 —</h2>');
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
  test("keeps plain MDX: no charset, ids, components export, highlighting or HTML attribute names", async () => {
    // The fixture's rehype plugin sets `tabIndex`, which an Astro project would write as `tabindex`.
    expect(await page("native", "index.html")).toBe(
      '<h1>Hello world!</h1>\n<pre tabIndex="0"><code class="language-js">const answer = 42;\n</code></pre>',
    );
  });
});

/** What Astro 5.16.11 with `@astrojs/mdx` 4.3.13 builds from the fixture. */
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
      '<!DOCTYPE html><meta charset="utf-8"/><pre class="astro-code github-dark" style="background-color:#24292e;color:#e1e4e8;overflow-x:auto" tabindex="0" data-language="js" data-seen><code><span class="line"><span style="color:#F97583">const</span><span style="color:#79B8FF"> answer</span><span style="color:#F97583"> =</span><span style="color:#79B8FF"> 42</span><span style="color:#E1E4E8">;</span></span></code></pre>\n' +
        '<pre><code class="language-math">x^2\n</code></pre>\n' +
        '<pre class="astro-code github-dark" style="background-color:#24292e;color:#e1e4e8;overflow-x:auto" tabindex="0" data-language="plaintext" data-seen><code><span class="line"><span>plain text</span></span></code></pre>',
    );
  });

  test("follows markdown.shikiConfig and syntaxHighlight.excludeLangs", async () => {
    await expectAstroOutput(
      "shikiTheme",
      '<!DOCTYPE html><meta charset="utf-8"/><pre class="astro-code nord" style="background-color:#2e3440ff;color:#d8dee9ff;overflow-x:auto;white-space:pre-wrap;word-wrap:break-word" tabindex="0" data-language="js"><code><span class="line"><span style="color:#81A1C1">const</span><span style="color:#D8DEE9"> answer</span><span style="color:#81A1C1"> =</span><span style="color:#B48EAD"> 42</span><span style="color:#81A1C1">;</span></span></code></pre>\n' +
        '<pre><code class="language-text">left alone\n</code></pre>',
    );
  });

  test("is left as is with syntaxHighlight: false, its fence meta kept as metastring", async () => {
    await expectAstroOutput(
      "shikiOff",
      '<!DOCTYPE html><meta charset="utf-8"/><pre><code class="language-js" metastring="title=&#34;a/b.js&#34;">const answer = 42;\n</code></pre>',
    );
  });

  test("is highlighted by Astro's Prism with syntaxHighlight: \"prism\"", async () => {
    await expectAstroOutput(
      "prism",
      '<!DOCTYPE html><meta charset="utf-8"/><pre class="language-js" data-language="js"><code is:raw class="language-js"><span class="token keyword">const</span> answer <span class="token operator">=</span> <span class="token number">42</span><span class="token punctuation">;</span>\n</code></pre>',
    );
  });

  test("syntaxHighlight and shikiConfig are parsed as Astro's schema does", () => {
    expect(parseSyntaxHighlight(undefined, "m")).toEqual({ type: "shiki", excludeLangs: ["math"] });
    expect(parseSyntaxHighlight(false, "m")).toBe(false);
    expect(parseSyntaxHighlight("prism", "m")).toEqual({ type: "prism" });
    expect(parseSyntaxHighlight({ excludeLangs: ["sh"] }, "m")).toEqual({ type: "shiki", excludeLangs: ["sh"] });
    expect(() => parseSyntaxHighlight("highlightjs", "m")).toThrow('m.syntaxHighlight must be false, "shiki", "prism"');
    expect(() => parseSyntaxHighlight({ type: "shiki", excludeLangs: "sh" }, "m")).toThrow("m.syntaxHighlight must be");
    expect(() => parseSyntaxHighlight({ type: null }, "m")).toThrow("m.syntaxHighlight must be");
    expect(() => parseSyntaxHighlight({ excludeLangs: null }, "m")).toThrow("m.syntaxHighlight must be");
    expect(() => parseSyntaxHighlight(true, "m")).toThrow("m.syntaxHighlight must be");

    expect(parseShikiConfig(undefined, "m")).toEqual({});
    expect(parseShikiConfig({ theme: "nord", wrap: null, defaultColor: false }, "m")).toEqual({
      theme: "nord",
      wrap: null,
      defaultColor: false,
    });
    // Shiki 1 compat: `id` becomes `name`, `grammar` is merged into the language.
    const grammar = { scopeName: "source.x", patterns: [] };
    expect(parseShikiConfig({ langs: ["js", { id: "x", grammar }] }, "m").langs).toEqual([
      "js",
      { id: "x", grammar, name: "x", scopeName: "source.x", patterns: [] },
    ]);
    expect(() => parseShikiConfig("nord", "m")).toThrow('m.shikiConfig must be an object, got "nord"');
    expect(() => parseShikiConfig({ wrap: "yes" }, "m")).toThrow('m.shikiConfig.wrap must be a boolean or null, got "yes"');
    expect(() => parseShikiConfig({ langs: "js" }, "m")).toThrow("m.shikiConfig.langs must be an array");
    expect(() => parseShikiConfig({ langAlias: { a: 1 } }, "m")).toThrow("m.shikiConfig.langAlias must be an object of strings");
    expect(() => parseShikiConfig({ themes: ["nord"] }, "m")).toThrow("m.shikiConfig.themes must be an object");
    expect(() => parseShikiConfig({ defaultColor: true }, "m")).toThrow("m.shikiConfig.defaultColor must be a string or false");
    expect(() => parseShikiConfig({ transformers: {} }, "m")).toThrow("m.shikiConfig.transformers must be an array");
  });

  test("mdx({ syntaxHighlight, shikiConfig }) are checked the same, but taken as given, as @astrojs/mdx does", () => {
    expect(parseMdxSyntaxHighlight(undefined, "m")).toBeUndefined();
    expect(parseMdxSyntaxHighlight(false, "m")).toBe(false);
    expect(parseMdxSyntaxHighlight({ type: "prism" }, "m")).toEqual({ type: "prism" });
    expect(() => parseMdxSyntaxHighlight({ excludeLangs: ["sh"] }, "m")).toThrow("m.syntaxHighlight must be");
    expect(() => parseMdxSyntaxHighlight("highlightjs", "m")).toThrow("m.syntaxHighlight must be");

    expect(parseMdxShikiConfig(undefined, "m")).toBeUndefined();
    expect(parseMdxShikiConfig({ langs: [{ id: "x" }] }, "m")).toEqual({ langs: [{ id: "x" }] });
    expect(() => parseMdxShikiConfig({ wrap: 1 }, "m")).toThrow("m.shikiConfig.wrap must be a boolean or null");
  });
});

/**
 * A project outside the repo with its own `@astrojs/mdx` (pletivo stubs it) and the repo's astro; a
 * `bare` astro lacks `@astrojs/markdown-remark`, as Astro 7 may, and `none` has no astro at all.
 */
async function buildProject(
  files: Record<string, string>,
  astro: "repo" | "bare" | "none" = "repo",
): Promise<{ root: string; exitCode: number; output: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pletivo-mdx-"));
  await fs.mkdir(path.join(root, "node_modules/@astrojs/mdx"), { recursive: true });
  if (astro === "bare") {
    await Bun.write(path.join(root, "node_modules/astro/package.json"), '{"name":"astro","version":"7.4.2"}');
  } else if (astro === "repo") {
    await fs.symlink(path.resolve(import.meta.dir, "../../node_modules/astro"), path.join(root, "node_modules/astro"));
  }
  await Bun.write(
    path.join(root, "node_modules/@astrojs/mdx/package.json"),
    '{"name":"@astrojs/mdx","version":"4.3.13","type":"module","main":"index.js"}',
  );
  await Bun.write(path.join(root, "node_modules/@astrojs/mdx/index.js"), 'export default () => { throw new Error("not stubbed"); };');
  for (const [file, content] of Object.entries(files)) await Bun.write(path.join(root, file), content);
  const child = Bun.spawn(["bun", cli, "build"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { root, exitCode: await child.exited, output: stdout + stderr };
}

const CODE_PAGE = "```js\nconst answer = 42;\n```\n\n```math\nx^2\n```\n";

describe("mdx({...}) highlighting options", () => {
  const roots: string[] = [];
  afterAll(async () => {
    for (const root of roots) await fs.rm(root, { recursive: true, force: true });
  });

  async function built(config: string): Promise<string> {
    const result = await buildProject({ "astro.config.mjs": config, "src/pages/index.mdx": CODE_PAGE });
    roots.push(result.root);
    if (result.exitCode !== 0) throw new Error(result.output);
    return Bun.file(path.join(result.root, "dist/index.html")).text();
  }

  const same = (html: string) => normalizeAttributeSpelling(normalizeVoidElements(html));
  const math = '<pre><code class="language-math">x^2\n</code></pre>';

  test("extendMarkdownConfig: false drops markdown's highlighting and plugins; shikiConfig replaces markdown's", async () => {
    const html = await built(`import mdx from "@astrojs/mdx";
function rehypeMarkSeen() {
  const visit = (node) => {
    if (node.type === "element" && node.tagName === "pre") node.properties.dataSeen = "";
    node.children?.forEach(visit);
  };
  return visit;
}
export default {
  markdown: { syntaxHighlight: "prism", rehypePlugins: [rehypeMarkSeen] },
  integrations: [mdx({ extendMarkdownConfig: false, shikiConfig: { theme: "nord" } })],
};`);
    expect(same(html)).toBe(
      same(
        '<!DOCTYPE html><meta charset="utf-8"/><pre class="astro-code nord" style="background-color:#2e3440ff;color:#d8dee9ff;overflow-x:auto" tabindex="0" data-language="js"><code><span class="line"><span style="color:#81A1C1">const</span><span style="color:#D8DEE9"> answer</span><span style="color:#81A1C1"> =</span><span style="color:#B48EAD"> 42</span><span style="color:#81A1C1">;</span></span></code></pre>\n' +
          math,
      ),
    );
  });

  test("syntaxHighlight replaces markdown.syntaxHighlight", async () => {
    const html = await built(`import mdx from "@astrojs/mdx";
export default {
  markdown: { shikiConfig: { theme: "nord" } },
  integrations: [mdx({ syntaxHighlight: { type: "prism" } })],
};`);
    expect(same(html)).toBe(
      same(
        '<!DOCTYPE html><meta charset="utf-8"/><pre class="language-js" data-language="js"><code is:raw class="language-js"><span class="token keyword">const</span> answer <span class="token operator">=</span> <span class="token number">42</span><span class="token punctuation">;</span>\n</code></pre>\n' +
          math,
      ),
    );
  });

  test("a project's MDX files share one Shiki highlighter", async () => {
    // Shiki warns at its 10th live highlighter; one per file would cross it.
    const files: Record<string, string> = { "astro.config.mjs": "export default {};" };
    for (let i = 0; i < 12; i++) files[`src/pages/page-${i}.mdx`] = CODE_PAGE;
    const result = await buildProject(files);
    roots.push(result.root);
    expect(result.exitCode).toBe(0);
    expect(result.output).not.toContain("instances have been created");
    expect(await Bun.file(path.join(result.root, "dist/page-11/index.html")).text()).toContain('<pre class="astro-code github-dark"');
  });

  for (const [astro, missing] of [
    ["bare", "@astrojs/markdown-remark"],
    ["none", "astro"],
  ] as const) {
    test(`without ${missing}, MDX builds unhighlighted and the build warns once`, async () => {
      const files: Record<string, string> = { "astro.config.mjs": "export default {};", "src/pages/plain.mdx": "# Plain\n" };
      for (let i = 0; i < 3; i++) files[`src/pages/page-${i}.mdx`] = CODE_PAGE;
      const result = await buildProject(files, astro);
      roots.push(result.root);
      expect(result.exitCode).toBe(0);
      expect(result.output.split(`MDX code blocks are not highlighted: \`${missing}\` cannot be resolved`)).toHaveLength(2);
      expect(result.output).toContain(
        `Install \`${missing}\`, or set \`syntaxHighlight: false\` in \`markdown\` or in \`mdx()\` to silence this warning.`,
      );
      expect(same(await Bun.file(path.join(result.root, "dist/page-2/index.html")).text())).toBe(
        same('<!DOCTYPE html><meta charset="utf-8"/><pre><code class="language-js">const answer = 42;\n</code></pre>\n' + math),
      );
      expect(same(await Bun.file(path.join(result.root, "dist/plain/index.html")).text())).toBe(
        same('<!DOCTYPE html><meta charset="utf-8"/><h1 id="plain">Plain</h1>'),
      );
    });
  }
});
