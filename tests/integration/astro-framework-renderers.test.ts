/**
 * Framework components render through each integration's own server renderer, wrapped in
 * `<astro-island>` with Astro's island scripts, and hydrate from the client bundles the
 * build writes at the islands' URLs. Each fixture builds in its own `pletivo build`
 * process: the framework compilers are Bun plugins, registered once per process.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "fs/promises";
import path from "path";

const cli = path.resolve(import.meta.dir, "../../packages/pletivo/src/cli.ts");
const FIXTURES = ["preact", "react", "solid", "svelte", "vue", "multi", "mdx", "missing"] as const;
type Fixture = (typeof FIXTURES)[number];

const fixtureRoot = (name: Fixture) => path.join(import.meta.dir, `../fixture-astro-renderers-${name}`);

interface Built {
  exitCode: number;
  output: string;
  html: string | null;
}

const built = new Map<Fixture, Built>();

async function buildFixture(name: Fixture): Promise<Built> {
  const root = fixtureRoot(name);
  const child = Bun.spawn(["bun", cli, "build"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const exitCode = await child.exited;
  const page = Bun.file(path.join(root, "dist/index.html"));
  return { exitCode, output: stdout + stderr, html: exitCode === 0 && (await page.exists()) ? await page.text() : null };
}

beforeAll(async () => {
  for (const name of FIXTURES) built.set(name, await buildFixture(name));
}, 240_000);

afterAll(async () => {
  for (const name of FIXTURES) await fs.rm(path.join(fixtureRoot(name), "dist"), { recursive: true, force: true });
});

function page(name: Fixture): string {
  const result = built.get(name);
  if (!result) throw new Error(`${name} was not built`);
  if (result.html === null) throw new Error(`${name} failed to build (exit ${result.exitCode}):\n${result.output}`);
  return result.html;
}

/** The `<astro-island …>` opening tags, in document order. */
function islands(html: string): string[] {
  return [...html.matchAll(/<astro-island [^>]*>/g)].map((match) => match[0]);
}

function attribute(tag: string, name: string): string | null {
  return tag.match(new RegExp(` ${name}="([^"]*)"`))?.[1] ?? null;
}

function count(html: string, text: string): number {
  return html.split(text).length - 1;
}

const ISLAND_STYLE = "<style>astro-island,astro-slot,astro-static-slot{display:contents}</style>";
/** Astro's `<astro-island>` custom element definition, inlined once per page. */
const ISLAND_SCRIPT = 'customElements.define("astro-island"';
const directiveScript = (directive: string) => `(self.Astro||(self.Astro={})).${directive}=`;

/**
 * Every island and renderer URL the page references is a module the build wrote. None ships
 * an uncompiled Svelte rune: `@astrojs/svelte`'s client is a `.svelte.js` module.
 */
async function expectBundles(name: Fixture, html: string): Promise<void> {
  const urls = islands(html).flatMap((tag) => [attribute(tag, "component-url"), attribute(tag, "renderer-url")]);
  expect(urls.length).toBeGreaterThan(0);
  for (const url of urls) {
    expect(url).toStartWith("/_astro/");
    const file = Bun.file(path.join(fixtureRoot(name), "dist", url ?? ""));
    expect({ url, exists: await file.exists() }).toEqual({ url, exists: true });
    const code = await file.text();
    expect(code.length).toBeGreaterThan(0);
    expect({ url, rune: code.match(/\$(state|derived|effect|props)\(/)?.[0] ?? null }).toEqual({ url, rune: null });
  }
}

/** The page's CSS: its inline `<style>` blocks and every stylesheet it links. */
async function pageCss(name: Fixture, html: string): Promise<string> {
  const inline = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((match) => match[1]);
  const linked = await Promise.all(
    [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((match) =>
      Bun.file(path.join(fixtureRoot(name), "dist", match[1])).text(),
    ),
  );
  return [...inline, ...linked].join("\n");
}

/**
 * A component's `<style>` resolves relative references from the component's directory, as under
 * Vite: its `@import` (of a stylesheet outside srcDir, so only the import can bring it) is inlined,
 * and its `url(./bg.svg)`, above the 4 kB inline limit, becomes a file the build wrote.
 */
async function expectStyleReferencesResolved(name: Fixture, css: string): Promise<void> {
  expect(css).toContain(`.${name}-imported{color:#1f2021}`);
  const image = css.match(/url\((\/assets\/bg\.[0-9a-f]+\.svg)\)/)?.[1];
  if (image === undefined) throw new Error(`no emitted bg.svg url() in the page CSS:\n${css}`);
  expect(await Bun.file(path.join(fixtureRoot(name), "dist", image)).exists()).toBe(true);
}

function expectScriptsOnceBeforeFirstIsland(html: string, directives: readonly string[]): void {
  expect(count(html, ISLAND_STYLE)).toBe(1);
  expect(count(html, ISLAND_SCRIPT)).toBe(1);
  for (const directive of directives) expect(count(html, directiveScript(directive))).toBe(1);
  const first = html.indexOf("<astro-island");
  expect(html.indexOf(ISLAND_STYLE)).toBeLessThan(html.indexOf(directiveScript(directives[0])));
  expect(html.indexOf(directiveScript(directives[0]))).toBeLessThan(html.indexOf(ISLAND_SCRIPT));
  expect(html.indexOf(ISLAND_SCRIPT)).toBeLessThan(first);
  expect(html).not.toContain("pletivo-island-prescript");
}

describe("a single-framework page", () => {
  test("Preact: hydrated islands carry the component's server render, a static one renders bare", async () => {
    const html = page("preact");
    const [loaded, visible, ...rest] = islands(html);
    expect(rest).toEqual([]);
    expect(attribute(loaded, "client")).toBe("load");
    expect(attribute(loaded, "component-export")).toBe("default");
    expect(attribute(loaded, "props")).toBe("{&quot;start&quot;:[0,1]}");
    expect(attribute(visible, "client")).toBe("visible");
    expect(html).toContain('<button>preact 1</button><div class="message"><astro-slot><h1>Hello, Preact!</h1></astro-slot></div>');
    // Without a directive the renderer's markup is written as is, outside any island.
    expect(html).toMatch(/<\/astro-island>\s*<div class="preact-counter"><button>preact 3<\/button>/);
    // The second island's directive gets its own script, ahead of that island only.
    expectScriptsOnceBeforeFirstIsland(html, ["load"]);
    expect(html.indexOf(directiveScript("visible"))).toBeGreaterThan(html.indexOf("<astro-island"));
    expect(html.indexOf(directiveScript("visible"))).toBeLessThan(html.lastIndexOf("<astro-island"));
    await expectBundles("preact", html);
    expect(await pageCss("preact", html)).toContain(".preact-counter");
  });

  test("React: the island carries React's identifier prefix", async () => {
    const html = page("react");
    const [island] = islands(html);
    expect(attribute(island, "prefix")).toBe("r1");
    expect(attribute(island, "component-export")).toBe("Counter");
    expect(html).toContain('<div class="react-counter"><button>react <!-- -->1</button>');
    expectScriptsOnceBeforeFirstIsland(html, ["load"]);
    await expectBundles("react", html);
    expect(await pageCss("react", html)).toContain(".react-counter");
  });

  test("Solid: hydration keys and Solid's hydration script ahead of the island", async () => {
    const html = page("solid");
    const [island] = islands(html);
    expect(attribute(island, "data-solid-render-id")).toBe("s0");
    expect(html).toContain('<div data-hk="s00000" class="solid-counter">');
    expectScriptsOnceBeforeFirstIsland(html, ["load"]);
    expect(count(html, "window._$HY||")).toBe(1);
    expect(html.indexOf("window._$HY||")).toBeLessThan(html.indexOf("<astro-island"));
    await expectBundles("solid", html);
    expect(await pageCss("solid", html)).toContain(".solid-counter");
  });

  // Its state comes from the project's own `count.svelte.js`, which both the server render and the bundle compile.
  test("Svelte: the component and its .svelte.js module compile, and its scoped CSS reaches the page", async () => {
    const html = page("svelte");
    const scope = html.match(/class="svelte-counter (svelte-[a-z0-9]+)"/)?.[1];
    expect(scope).toBeString();
    expect(html).toContain("<button>svelte 1</button>");
    expectScriptsOnceBeforeFirstIsland(html, ["load"]);
    await expectBundles("svelte", html);
    const css = await pageCss("svelte", html);
    expect(css).toMatch(new RegExp(`\\.svelte-counter\\.${scope}\\s*\\{`));
    await expectStyleReferencesResolved("svelte", css);
  });

  test("Vue: the island carries Vue's prefix and the scoped style reaches the page", async () => {
    const html = page("vue");
    const [island] = islands(html);
    expect(attribute(island, "prefix")).toBe("s0");
    const scope = html.match(/class="vue-counter" (data-v-[a-f0-9]+)/)?.[1];
    expect(scope).toBeString();
    expect(html).toContain("vue 1</button>");
    expectScriptsOnceBeforeFirstIsland(html, ["load"]);
    await expectBundles("vue", html);
    const css = await pageCss("vue", html);
    expect(css).toContain(`.vue-counter[${scope}]`);
    await expectStyleReferencesResolved("vue", css);
  });
});

describe("component CSS across pages", () => {
  test("each page links the CSS of the components it renders, and only those", async () => {
    const index = page("vue");
    const other = await Bun.file(path.join(fixtureRoot("vue"), "dist/other/index.html")).text();
    const [indexCss, otherCss] = [await pageCss("vue", index), await pageCss("vue", other)];
    // Counter is on both pages; Other only on the second.
    expect(indexCss).toContain(".vue-counter[");
    expect(otherCss).toContain(".vue-counter[");
    expect(otherCss).toContain(".vue-other[");
    expect(indexCss).not.toContain(".vue-other");
  });
});

describe("the container API", () => {
  test("renderToString settles its islands' scripts: once each, ahead of the first island, no sentinel", async () => {
    page("preact");
    // An endpoint's body is written as is, so only the container can have settled them.
    const html = await Bun.file(path.join(fixtureRoot("preact"), "dist/widget.html")).text();
    expect(islands(html)).toHaveLength(2);
    expectScriptsOnceBeforeFirstIsland(html, ["load"]);
  });
});

describe("a page with every framework", () => {
  test("each component goes to its own renderer, in registration order of the checks", () => {
    const html = page("multi");
    const tags = islands(html);
    expect(tags.map((tag) => attribute(tag, "opts"))).toEqual(
      ["react.Counter", "PreactCounter", "SolidCounter", "VueCounter", "SvelteCounter"].map(
        (name) => `{&quot;name&quot;:&quot;${name}&quot;,&quot;value&quot;:true}`,
      ),
    );
    // React's check renders, so it spends r0 and r1 on the components it is offered before its own.
    expect(attribute(tags[0], "prefix")).toBe("r2");
    expect(attribute(tags[2], "data-solid-render-id")).toBe("s0");
    expect(attribute(tags[3], "prefix")).toBe("s0");
    for (const label of ["react 0", "preact 0", "solid 0", "vue 0", "svelte 0"]) {
      expect(html.replace(/<!--[^>]*-->/g, "")).toContain(label);
    }
  });

  test("each script is written once, ahead of the first island that needs it", () => {
    const html = page("multi");
    expectScriptsOnceBeforeFirstIsland(html, ["visible", "load", "idle"]);
    const tags = islands(html);
    const at = (tag: string) => html.indexOf(tag);
    expect(html.indexOf(directiveScript("load"))).toBeLessThan(at(tags[1]));
    expect(html.indexOf(directiveScript("load"))).toBeGreaterThan(at(tags[0]));
    expect(html.indexOf("window._$HY||")).toBeGreaterThan(at(tags[1]));
    expect(html.indexOf("window._$HY||")).toBeLessThan(at(tags[2]));
    expect(html.indexOf(directiveScript("idle"))).toBeLessThan(at(tags[3]));
  });

  test("every renderer client and component module is written", async () => {
    await expectBundles("multi", page("multi"));
  });
});

describe("an MDX page", () => {
  test("its islands render through the renderer, their scripts hoisted to the start of the content", async () => {
    const html = page("mdx");
    const [island] = islands(html);
    expect(attribute(island, "client")).toBe("idle");
    expect(attribute(island, "component-export")).toBe("default");
    expect(html).toContain('<div class="message"><astro-slot>This is a <strong>counter</strong>!</astro-slot></div>');
    expectScriptsOnceBeforeFirstIsland(html, ["idle"]);
    // Astro writes the content's island scripts ahead of its first element.
    expect(html.indexOf(ISLAND_SCRIPT)).toBeLessThan(html.indexOf('<h1 id="hello-mdx">Hello MDX</h1>'));
    await expectBundles("mdx", html);
  });
});

describe("a component whose renderer is not registered", () => {
  test("fails the build, naming the component and the integration it needs", () => {
    const result = built.get("missing");
    expect(result?.exitCode).not.toBe(0);
    expect(result?.output).toContain("pletivo cannot render Vue components: src/components/Counter.vue, imported by src/pages/index.astro");
    expect(result?.output).toContain("add @astrojs/vue to the integrations in astro.config");
  });
});
