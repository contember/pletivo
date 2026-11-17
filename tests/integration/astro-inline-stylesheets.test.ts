import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test";
import path from "path";
import os from "os";
import fs from "fs/promises";
import { spawnSync } from "child_process";
import { build } from "../../packages/pletivo/src/build";
import { __resetForTests } from "../../packages/pletivo/src/astro-host/runner";
import type { PletivoConfig } from "../../packages/pletivo/src/config";

setDefaultTimeout(60_000);

/**
 * Astro's `build.inlineStylesheets` (5.16.11, `plugin-css.ts`): a built stylesheet
 * strictly below `vite.build.assetsInlineLimit` is inlined as `<style>` on every
 * page that uses it and not emitted; adjacent inline sheets merge into one `<style>`.
 * The fixtures import CSS from outside `src/`, so each page's CSS is its own group.
 */

const repoRoot = path.resolve(import.meta.dir, "../..");
const cliPath = path.join(repoRoot, "packages/pletivo/src/cli.ts");

function pletivoConfig(base = "/"): PletivoConfig {
  return { host: "localhost", outDir: "dist", port: 3000, base, srcDir: "src", publicDir: "public" };
}

/** CSS that minifies to `.name{--pad:xxx}\n` of exactly `bytes` bytes. */
function sheetOfSize(name: string, bytes: number): string {
  const overhead = Buffer.byteLength(`.${name}{--pad:}\n`);
  return `.${name} {\n  --pad: ${"x".repeat(bytes - overhead)};\n}\n`;
}

/** Deterministic incompressible bytes, an image stand-in. */
function noise(n: number, seed: number): Buffer {
  const buf = Buffer.alloc(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    buf[i] = x & 0xff;
  }
  return buf;
}

/** An Astro page that imports `css` and carries its own global `<style>`. */
function page(css: string, pageRule: string): string {
  return `---\nimport "${css}";\n---\n<html><head><title>t</title><style is:global>${pageRule}</style></head><body><h1>t</h1></body></html>\n`;
}

const tmpRoots: string[] = [];

async function project(files: Record<string, string | Buffer>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pletivo-inline-css-"));
  tmpRoots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), content);
  }
  return root;
}

afterAll(async () => {
  __resetForTests();
  await Promise.all(tmpRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function buildProject(root: string, base = "/"): Promise<void> {
  __resetForTests();
  await build(root, pletivoConfig(base));
}

type HeadSheet = { link: string } | { style: string };

/** The page's stylesheet tags, in document order. */
async function sheetsOf(root: string, pageRel: string): Promise<HeadSheet[]> {
  const html = await fs.readFile(path.join(root, "dist", pageRel), "utf8");
  return [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">|<style>([\s\S]*?)<\/style>/g)].map((m) =>
    m[1] !== undefined ? { link: m[1] } : { style: m[2] },
  );
}

function styles(sheets: HeadSheet[]): string[] {
  return sheets.flatMap((s) => ("style" in s ? [s.style] : []));
}

function links(sheets: HeadSheet[]): string[] {
  return sheets.flatMap((s) => ("link" in s ? [s.link] : []));
}

/** Every stylesheet written to `dist/assets/`, by name. */
async function emittedSheets(root: string): Promise<Map<string, string>> {
  const dir = path.join(root, "dist", "assets");
  const out = new Map<string, string>();
  let names: string[] = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return out;
  }
  for (const name of names.filter((n) => n.endsWith(".css"))) {
    out.set(name, await fs.readFile(path.join(dir, name), "utf8"));
  }
  return out;
}

async function linkedCss(root: string, href: string, base = ""): Promise<string> {
  return await fs.readFile(path.join(root, "dist", href.slice(base.length).replace(/^\//, "")), "utf8");
}

describe("inlineStylesheets: auto (the default)", () => {
  let root = "";
  beforeAll(async () => {
    root = await project({
      "astro.config.mjs": "export default {};\n",
      "vendor/small.css": ".small-marker { color: rgb(1, 2, 3); }\n",
      "vendor/big.css": sheetOfSize("big-marker", 6000),
      "vendor/below.css": sheetOfSize("below-marker", 4095),
      "vendor/at.css": sheetOfSize("at-marker", 4096),
      "vendor/shared.css": ".shared-marker { color: rgb(4, 5, 6); }\n",
      "vendor/font.css": `@font-face { font-family: "Probe"; src: url(./files/probe.woff2); }\n.font-marker { font-family: "Probe"; }\n`,
      "vendor/files/probe.woff2": noise(5000, 1),
      "src/pages/small.astro": page("../../vendor/small.css", ".small-page{color:blue}"),
      "src/pages/big.astro": page("../../vendor/big.css", ".big-page{color:blue}"),
      "src/pages/below.astro": page("../../vendor/below.css", ".below-page{color:blue}"),
      "src/pages/at.astro": page("../../vendor/at.css", ".at-page{color:blue}"),
      "src/pages/shared-a.astro": page("../../vendor/shared.css", ".shared-a-page{color:blue}"),
      "src/pages/shared-b.astro": page("../../vendor/shared.css", ".shared-b-page{color:blue}"),
      "src/pages/deep/font.astro": page("../../../vendor/font.css", ".font-page{color:blue}"),
      "src/pages/notes.md": "# Notes\n",
    });
    await buildProject(root);
  });

  test("a sheet under the limit is inlined and merges with the page's own <style>", async () => {
    const sheets = await sheetsOf(root, "small/index.html");
    expect(links(sheets)).toEqual([]);
    expect(styles(sheets)).toHaveLength(1);
    const [css] = styles(sheets);
    expect(css).toContain(".small-marker{color:#010203}");
    // The sheet first, then the page's CSS, as Astro's cascade order has it.
    expect(css.indexOf(".small-marker")).toBeLessThan(css.indexOf(".small-page"));
  });

  test("a sheet over the limit stays linked, before the page's own <style>", async () => {
    const sheets = await sheetsOf(root, "big/index.html");
    expect(sheets).toHaveLength(2);
    const [link, style] = sheets;
    if (!("link" in link) || !("style" in style)) throw new Error(`expected a link then a style, got ${JSON.stringify(sheets)}`);
    expect(await linkedCss(root, link.link)).toContain(".big-marker{");
    expect(style.style).toContain(".big-page");
    expect(style.style).not.toContain(".big-marker");
  });

  test("at the limit a sheet is linked; one byte below it is inlined", async () => {
    const below = await sheetsOf(root, "below/index.html");
    expect(links(below)).toEqual([]);
    const inlined = styles(below)[0];
    const belowSheet = inlined.slice(0, inlined.indexOf(".below-page"));
    expect(Buffer.byteLength(belowSheet)).toBe(4095);

    const at = await sheetsOf(root, "at/index.html");
    const [href] = links(at);
    expect(href).toBeDefined();
    expect(Buffer.byteLength(await linkedCss(root, href))).toBe(4096);
    expect(styles(at).join("")).not.toContain(".at-marker");
  });

  test("a sheet two pages share is inlined on both", async () => {
    for (const rel of ["shared-a/index.html", "shared-b/index.html"]) {
      const sheets = await sheetsOf(root, rel);
      expect(links(sheets)).toEqual([]);
      expect(styles(sheets).join("")).toContain(".shared-marker{color:#040506}");
    }
  });

  test("an inlined sheet is not written to dist", async () => {
    const all = [...(await emittedSheets(root)).values()].join("\n");
    for (const marker of [".small-marker", ".below-marker", ".shared-marker", ".font-marker"]) {
      expect(all).not.toContain(marker);
    }
    expect(all).toContain(".big-marker");
    expect(all).toContain(".at-marker");
  });

  test("an asset url() in an inlined sheet resolves from a nested page", async () => {
    const sheets = await sheetsOf(root, "deep/font/index.html");
    expect(links(sheets)).toEqual([]);
    const css = styles(sheets).join("");
    const url = css.match(/url\("?([^")]+)"?\)/)?.[1];
    // Site-absolute, so it does not depend on the page's own URL.
    expect(url).toMatch(/^\/assets\/probe\.[a-f0-9]{8}\.woff2$/);
    if (!url) throw new Error("no url() in the inlined sheet");
    const written = await fs.readFile(path.join(root, "dist", url));
    expect(written.equals(noise(5000, 1))).toBe(true);
  });

  test("a page with unknown CSS reach gets every group, each inlined or linked as decided", async () => {
    const sheets = await sheetsOf(root, "notes/index.html");
    const inline = styles(sheets).join("");
    for (const marker of [".small-marker", ".below-marker", ".shared-marker", ".font-marker"]) {
      expect(inline).toContain(marker);
    }
    const linked = await Promise.all(links(sheets).map((href) => linkedCss(root, href)));
    expect(linked.join("\n")).toContain(".big-marker");
    expect(linked.join("\n")).toContain(".at-marker");
    // Inline groups that sit next to each other share one <style>.
    expect(styles(sheets).length).toBeLessThan(4);
  });
});

describe("inlineStylesheets: always and never", () => {
  test("always inlines a sheet over the limit and writes no stylesheet", async () => {
    const root = await project({
      "astro.config.mjs": `export default { build: { inlineStylesheets: "always" } };\n`,
      "vendor/big.css": sheetOfSize("big-marker", 6000),
      "src/pages/index.astro": page("../../vendor/big.css", ".index-page{color:blue}"),
    });
    await buildProject(root);
    const sheets = await sheetsOf(root, "index.html");
    expect(links(sheets)).toEqual([]);
    expect(styles(sheets)).toHaveLength(1);
    expect(styles(sheets)[0]).toContain(".big-marker{");
    expect((await emittedSheets(root)).size).toBe(0);
  });

  test("never links a small sheet, in the markup a project without Astro gets", async () => {
    const root = await project({
      "astro.config.mjs": `export default { build: { inlineStylesheets: "never" } };\n`,
      "vendor/small.css": ".small-marker { color: rgb(1, 2, 3); }\n",
      "src/pages/index.astro": page("../../vendor/small.css", ".index-page{color:blue}"),
    });
    await buildProject(root);
    const html = await fs.readFile(path.join(root, "dist/index.html"), "utf8");
    expect(html).toMatch(/<link rel="stylesheet" href="\/assets\/styles\.pages\.[a-f0-9]{8}\.css">\n<style>\.index-page\{color:blue\}<\/style>\n<\/head>/);
  });

  test("an invalid value fails the build, as Astro's config schema does", async () => {
    const root = await project({
      "astro.config.mjs": `export default { build: { inlineStylesheets: "sometimes" } };\n`,
      "src/pages/index.astro": "<html><head></head><body></body></html>\n",
    });
    __resetForTests();
    expect(build(root, pletivoConfig())).rejects.toThrow('build.inlineStylesheets must be "always", "auto" or "never", got "sometimes"');
  });
});

describe("vite.build.assetsInlineLimit", () => {
  test("a number moves the stylesheet and the url() asset limits, under a base path", async () => {
    const root = await project({
      "astro.config.mjs": `export default { base: "/docs", vite: { build: { assetsInlineLimit: 200 } } };\n`,
      "vendor/below.css": sheetOfSize("below-marker", 199),
      "vendor/at.css": sheetOfSize("at-marker", 200),
      "vendor/img.css": `.img-big { background: url(./files/big.png); }\n.img-small { background: url(./files/small.png); }\n`,
      "vendor/files/big.png": noise(300, 2),
      "vendor/files/small.png": noise(100, 3),
      "src/pages/below.astro": page("../../vendor/below.css", ".below-page{color:blue}"),
      "src/pages/at.astro": page("../../vendor/at.css", ".at-page{color:blue}"),
      "src/pages/img.astro": page("../../vendor/img.css", ".img-page{color:blue}"),
    });
    await buildProject(root, "/docs");

    const below = await sheetsOf(root, "below/index.html");
    expect(links(below)).toEqual([]);
    expect(styles(below)[0]).toContain(".below-marker{");

    const at = await sheetsOf(root, "at/index.html");
    const [href] = links(at);
    expect(href).toMatch(/^\/docs\/assets\/styles\.at\.[a-f0-9]{8}\.css$/);
    expect(Buffer.byteLength(await linkedCss(root, href, "/docs"))).toBe(200);

    // 300 B is under Vite's default 4096 but over this limit: a file, not a data: URI.
    const img = await sheetsOf(root, "img/index.html");
    const css = [...styles(img), ...(await Promise.all(links(img).map((h) => linkedCss(root, h, "/docs"))))].join("\n");
    const bigUrl = css.match(/\.img-big\{background:url\("?([^")]+)"?\)/)?.[1];
    expect(bigUrl).toMatch(/^\/docs\/assets\/big\.[a-f0-9]{8}\.png$/);
    expect(css).toMatch(/\.img-small\{background:url\("?data:image\/png;base64,/);
  });

  test("a function decides per sheet, given the sheet's dist-relative path", async () => {
    const root = await project({
      "astro.config.mjs": `export default { vite: { build: { assetsInlineLimit(filePath, content) {
        if (!/^assets\\/styles\\..+\\.css$/.test(filePath)) return undefined;
        const css = content.toString();
        if (css.includes("fn-inline")) return true;
        if (css.includes("fn-link")) return false;
        return undefined;
      } } } };\n`,
      "vendor/inline.css": sheetOfSize("fn-inline", 6000),
      "vendor/link.css": ".fn-link { color: red; }\n",
      "vendor/default.css": ".fn-default { color: red; }\n",
      "src/pages/inline.astro": page("../../vendor/inline.css", ".inline-page{color:blue}"),
      "src/pages/link.astro": page("../../vendor/link.css", ".link-page{color:blue}"),
      "src/pages/default.astro": page("../../vendor/default.css", ".default-page{color:blue}"),
    });
    await buildProject(root);

    expect(styles(await sheetsOf(root, "inline/index.html")).join("")).toContain(".fn-inline{");
    const link = await sheetsOf(root, "link/index.html");
    expect(links(link)).toHaveLength(1);
    expect(styles(link).join("")).not.toContain(".fn-link");
    // `undefined` falls back to 4096 B.
    expect(styles(await sheetsOf(root, "default/index.html")).join("")).toContain(".fn-default{");
  });
});

describe("a project without an Astro config", () => {
  test("links a small sheet, as before", async () => {
    const root = await project({
      "vendor/small.css": ".small-marker { color: rgb(1, 2, 3); }\n",
      "src/pages/index.astro": page("../../vendor/small.css", ".index-page{color:blue}"),
    });
    await buildProject(root);
    const html = await fs.readFile(path.join(root, "dist/index.html"), "utf8");
    expect(html).toMatch(/<link rel="stylesheet" href="\/assets\/styles\.pages\.[a-f0-9]{8}\.css">\n<style>\.index-page\{color:blue\}<\/style>\n<\/head>/);
  });
});

describe("incremental build", () => {
  function runBuild(root: string): { stdout: string; status: number; stderr: string } {
    const result = spawnSync("bun", ["run", cliPath, "build", "--incremental"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, NODE_ENV: "production" },
    });
    return { stdout: result.stdout, stderr: result.stderr, status: result.status ?? -1 };
  }

  test("a cached page picks up a changed inlined sheet", async () => {
    // Hoisted-script CSS lands in the shared sheet, which every page gets.
    const root = await project({
      "astro.config.mjs": "export default {};\n",
      "vendor/hoisted.css": ".hoisted-v1 { color: red; }\n",
      "src/scripts/entry.js": `import "../../vendor/hoisted.css";\ndocument.documentElement.dataset.x = "1";\n`,
      "src/pages/index.astro": `<html><head><title>i</title><style is:global>.index-page{color:blue}</style></head><body><h1>i</h1></body></html>\n<script>\n  import "../scripts/entry.js";\n</script>\n`,
      "src/pages/about.ts": `export default function About() {\n  return { __html: '<!DOCTYPE html><html><head><title>About</title></head><body><h1>About</h1></body></html>' };\n}\n`,
    });
    const first = runBuild(root);
    expect(first.status).toBe(0);
    const before = await sheetsOf(root, "about/index.html");
    expect(links(before)).toEqual([]);
    expect(styles(before).join("")).toContain(".hoisted-v1");

    await fs.writeFile(path.join(root, "vendor/hoisted.css"), ".hoisted-v2 { color: blue; }\n");
    const second = runBuild(root);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("about.ts → dist/about/index.html");
    expect(second.stdout).toContain("[cached]");

    const after = await sheetsOf(root, "about/index.html");
    expect(links(after)).toEqual([]);
    expect(styles(after)).toHaveLength(1);
    expect(styles(after)[0]).toContain(".hoisted-v2");
    expect(styles(after)[0]).not.toContain(".hoisted-v1");
    expect((await emittedSheets(root)).size).toBe(0);

    // A third build with nothing changed leaves the refreshed markup alone.
    const html = await fs.readFile(path.join(root, "dist/about/index.html"), "utf8");
    expect(runBuild(root).status).toBe(0);
    expect(await fs.readFile(path.join(root, "dist/about/index.html"), "utf8")).toBe(html);
  });
});
