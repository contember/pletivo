import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test";
import path from "path";
import os from "os";
import fs from "fs/promises";
import { spawnSync } from "child_process";
import { build } from "../../packages/pletivo/src/build";
import { __resetForTests } from "../../packages/pletivo/src/astro-host/runner";
import type { PletivoConfig } from "../../packages/pletivo/src/config";

setDefaultTimeout(60_000);

// Astro 5.16.11 `build.inlineStylesheets`: a sheet strictly below `assetsInlineLimit` is inlined on every
// page that uses it and not emitted; adjacent inline sheets merge. The fixtures import CSS from outside
// `src/`, so each page's CSS is its own group.

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

/** A tsconfig for a pletivo-native project outside the repo, pointing the JSX runtime at this checkout. */
function nativeTsconfig(): string {
  const runtime = path.join(repoRoot, "packages/runtime/src");
  return JSON.stringify({
    compilerOptions: {
      jsx: "react-jsx",
      jsxImportSource: "pletivo",
      paths: {
        "pletivo/jsx-runtime": [path.join(runtime, "jsx-runtime.ts")],
        "pletivo/jsx-dev-runtime": [path.join(runtime, "jsx-runtime.ts")],
        "preact/hooks": [path.join(runtime, "hooks.ts")],
      },
    },
  });
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

describe("</style inside inlined CSS", () => {
  test("is escaped as Astro's default build emits it, so the <style> ends where it should", async () => {
    const root = await project({
      "astro.config.mjs": "export default {};\n",
      "vendor/x.css": `.x::before { content: "</style><b>x</b>"; }\n.y::before { content: "</STYLE>"; }\n`,
      "src/pages/index.astro": page("../../vendor/x.css", ".index-page{color:blue}"),
    });
    await buildProject(root);
    const html = await fs.readFile(path.join(root, "dist/index.html"), "utf8");
    expect(html).toContain(`content:"<\\/style><b>x</b>"`);
    expect(html).toContain(`content:"<\\/STYLE>"`);
    // The only `</style` left is the element's own end tag.
    expect(html.match(/<\/style/gi)).toHaveLength(1);
    expect(styles(await sheetsOf(root, "index.html"))[0]).toContain(".index-page{color:blue}");
  });
});

describe("</style in a page's own CSS", () => {
  test("is escaped in the body fallback and in CSS-modules output", async () => {
    const root = await project({
      "tsconfig.json": nativeTsconfig(),
      "src/styles/box.module.css": `.box::before { content: "</style><b>m</b>"; }\n`,
      "src/pages/frag.tsx": `export default function Frag() {\n  return <html><body><style>{'.frag::before{content:"</style><b>f</b>"}'}</style><p class="frag">f</p></body></html>;\n}\n`,
      "src/pages/mod.tsx": `import styles from "../styles/box.module.css";\nexport default function Mod() {\n  return <html><head><title>m</title></head><body><p class={styles.box}>m</p></body></html>;\n}\n`,
    });
    await buildProject(root);
    // No `</head>`: the page's own CSS goes into the body.
    const frag = await fs.readFile(path.join(root, "dist/frag/index.html"), "utf8");
    expect(frag).toMatch(/<style>\.frag::before\{content:"<\\\/style><b>f<\/b>"\}<\/style>/);
    const mod = await fs.readFile(path.join(root, "dist/mod/index.html"), "utf8");
    expect(mod).toContain(`content: "<\\/style><b>m</b>"`);
    for (const html of [frag, mod]) expect(html).not.toContain("</style><b>");
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
  /** Runs the CLI build and returns its stdout; a failed build throws with its stderr. */
  function runBuild(root: string, incremental = true): string {
    const result = spawnSync("bun", ["run", cliPath, "build", ...(incremental ? ["--incremental"] : [])], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, NODE_ENV: "production" },
    });
    if (result.status !== 0) throw new Error(`build exited with ${result.status}:\n${result.stderr}`);
    return result.stdout;
  }

  /** Every file under `dist/`, dist-relative. */
  async function distFiles(root: string): Promise<string[]> {
    const dist = path.join(root, "dist");
    const entries = await fs.readdir(dist, { recursive: true, withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => path.relative(dist, path.join(e.parentPath, e.name))).sort();
  }

  /** The pages, and every file they reference through `<link href>`, `<script src>` and CSS `url()`. */
  async function servedFiles(root: string): Promise<Record<string, string>> {
    const dist = path.join(root, "dist");
    const origin = "http://site.invalid";
    const out: Record<string, string> = {};
    const read = async (rel: string): Promise<string | null> => {
      try {
        const bytes = await fs.readFile(path.join(dist, rel));
        return /\.(html|css|js)$/.test(rel) ? bytes.toString("utf8") : bytes.toString("base64");
      } catch {
        return null;
      }
    };
    const follow = async (ref: string, from: string): Promise<void> => {
      const url = new URL(ref, `${origin}/${from}`);
      if (url.origin !== origin) return;
      const rel = decodeURIComponent(url.pathname).slice(1);
      if (rel in out) return;
      const content = await read(rel);
      out[rel] = content ?? "<missing>";
      if (content !== null && rel.endsWith(".css")) await followCss(content, rel);
    };
    const followCss = async (css: string, from: string): Promise<void> => {
      for (const m of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) await follow(m[1], from);
    };
    for (const rel of (await distFiles(root)).filter((f) => f.endsWith(".html"))) {
      const html = await fs.readFile(path.join(dist, rel), "utf8");
      out[rel] = html;
      for (const m of html.matchAll(/<link\b[^>]*\bhref="([^"]+)"|<script\b[^>]*\bsrc="([^"]+)"/g)) await follow(m[1] ?? m[2], rel);
      for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)) await followCss(m[1], rel);
    }
    return out;
  }

  /**
   * Build a copy of the project's sources from scratch and compare what the pages serve. Returns the files only the
   * incremental `dist/` has: superseded stylesheets, which an incremental build keeps and no page references.
   */
  async function expectSameAsFullBuild(root: string): Promise<string[]> {
    const copy = await fs.mkdtemp(path.join(os.tmpdir(), "pletivo-inline-css-full-"));
    tmpRoots.push(copy);
    const skip = new Set([path.join(root, "dist"), path.join(root, "node_modules")]);
    await fs.cp(root, copy, { recursive: true, filter: (src) => !skip.has(src) });
    runBuild(copy, false);
    const served = await servedFiles(root);
    expect(served).toEqual(await servedFiles(copy));
    const full = new Set(await distFiles(copy));
    const orphans = (await distFiles(root)).filter((rel) => !full.has(rel));
    for (const rel of orphans) {
      expect(rel).toMatch(/^assets\/styles\.[^/]+\.css$/);
      expect(served[rel]).toBeUndefined();
    }
    return orphans;
  }

  // Hoisted-script CSS lands in the shared sheet, which every page gets. It sits
  // outside `src/`, so changing it leaves the pages that don't import it cached.
  const indexPage = `<html><head><title>i</title></head><body><h1>i</h1></body></html>\n<script>\n  import "../scripts/entry.js";\n</script>\n`;
  const aboutPage = `<html><head><title>a</title><style is:global>.about-page{color:green}</style></head><body><h1>a</h1></body></html>\n`;
  const entryScript = (imports: string) => `${imports}document.documentElement.dataset.x = "1";\n`;

  test("a cached page picks up a changed inlined sheet, next to its own <style>", async () => {
    const root = await project({
      "astro.config.mjs": "export default {};\n",
      "vendor/hoisted.css": ".hoisted-v1 { color: red; }\n",
      "src/scripts/entry.js": entryScript(`import "../../vendor/hoisted.css";\n`),
      "src/pages/index.astro": indexPage,
      "src/pages/about.astro": aboutPage,
    });
    runBuild(root);
    const before = await sheetsOf(root, "about/index.html");
    expect(links(before)).toEqual([]);
    expect(styles(before).join("")).toContain(".hoisted-v1");

    await fs.writeFile(path.join(root, "vendor/hoisted.css"), ".hoisted-v2 { color: blue; }\n");
    expect(runBuild(root)).toMatch(/about\.astro → dist\/about\/index\.html \([^)]*\) \[cached\]/);

    const after = await sheetsOf(root, "about/index.html");
    expect(links(after)).toEqual([]);
    expect(styles(after)).toHaveLength(1);
    const [css] = styles(after);
    expect(css).not.toContain(".hoisted-v1");
    expect(css.indexOf(".hoisted-v2")).toBeGreaterThanOrEqual(0);
    expect(css.indexOf(".hoisted-v2")).toBeLessThan(css.indexOf(".about-page"));
    expect((await emittedSheets(root)).size).toBe(0);
    await expectSameAsFullBuild(root);

    // A third build with nothing changed leaves the refreshed markup alone.
    const html = await fs.readFile(path.join(root, "dist/about/index.html"), "utf8");
    runBuild(root);
    expect(await fs.readFile(path.join(root, "dist/about/index.html"), "utf8")).toBe(html);
  });

  for (const [label, config] of [
    ["no other head injections", "export default {};\n"],
    [
      "an injected head script",
      `export default { integrations: [{ name: "head-script", hooks: { "astro:config:setup": ({ injectScript }) => injectScript("head-inline", "window.probe = 1;") } }] };\n`,
    ],
  ] as const) {
    test(`a cached page without CSS gains a sheet as a full build places it, with ${label}`, async () => {
      const root = await project({
        "astro.config.mjs": config,
        "vendor/hoisted.css": ".hoisted-marker { color: red; }\n",
        "src/scripts/entry.js": entryScript(""),
        "src/pages/index.astro": indexPage,
        "src/pages/plain.astro": "<html><head><title>p</title></head><body><h1>p</h1></body></html>\n",
      });
      runBuild(root);
      expect(styles(await sheetsOf(root, "plain/index.html"))).toEqual([]);

      await fs.writeFile(path.join(root, "src/scripts/entry.js"), entryScript(`import "../../vendor/hoisted.css";\n`));
      runBuild(root);
      expect(styles(await sheetsOf(root, "plain/index.html")).join("")).toContain(".hoisted-marker");
      await expectSameAsFullBuild(root);
    });
  }

  /** A project whose `astro:build:done` hook rewrites every HTML file with `rewrite` (a JS expression on `html`). */
  async function hookProject(build: string, rewrite: string, files: Record<string, string> = {}): Promise<string> {
    return await project({
      "astro.config.mjs": `import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const rewriteAll = (dir) => {
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const file = path.join(entry.parentPath, entry.name);
    if (!entry.isFile() || !file.endsWith(".html")) continue;
    const html = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, ${rewrite});
  }
};
export default { ${build}integrations: [{ name: "rewrite", hooks: { "astro:build:done": ({ dir }) => rewriteAll(fileURLToPath(dir)) } }] };
`,
      "vendor/hoisted.css": ".hoisted-v1 { color: red; }\n",
      "src/scripts/entry.js": entryScript(`import "../../vendor/hoisted.css";\n`),
      "src/pages/index.astro": indexPage,
      "src/pages/about.astro": aboutPage,
      ...files,
    });
  }
  const aboutCached = /about\.astro → dist\/about\/index\.html \([^)]*\) \[cached\]/;

  for (const [label, build] of [["auto", ""], ["never", `build: { inlineStylesheets: "never" }, `]] as const) {
    test(`a page an astro:build:done minifier collapsed stays cached and takes a changed sheet (${label})`, async () => {
      const root = await hookProject(build, String.raw`html.replace(/>\s+</g, "><")`);
      runBuild(root);
      expect(await fs.readFile(path.join(root, "dist/about/index.html"), "utf8")).not.toMatch(/>\s+</);
      // The collapsed markup is still found, so nothing re-renders.
      expect(runBuild(root)).toContain("0 rendered + 2 cached");

      await fs.writeFile(path.join(root, "vendor/hoisted.css"), ".hoisted-v2 { color: blue; }\n");
      expect(runBuild(root)).toMatch(aboutCached);
      await expectSameAsFullBuild(root);
    });

    test(`a page whose stylesheet markup a hook rewrote otherwise stays cached, then renders again for a new sheet (${label})`, async () => {
      const root = await hookProject(build, `html.replace(/<style>/g, '<style nonce="n">')`);
      runBuild(root);
      expect(await fs.readFile(path.join(root, "dist/about/index.html"), "utf8")).toContain('<style nonce="n">');
      // Nothing changed, so the markup is not looked for.
      expect(runBuild(root)).toContain("0 rendered + 2 cached");
      expect(runBuild(root)).toContain("0 rendered + 2 cached");

      await fs.writeFile(path.join(root, "vendor/hoisted.css"), ".hoisted-v2 { color: blue; }\n");
      expect(runBuild(root)).not.toMatch(aboutCached);
      await expectSameAsFullBuild(root);
    });
  }

  test("a cached page without CSS gains a sheet when a hook removed its </head>", async () => {
    const root = await hookProject("", `html.replace("</head>", "")`, {
      "src/scripts/entry.js": entryScript(""),
      "src/pages/plain.astro": "<html><head><title>p</title></head><body><h1>p</h1></body></html>\n",
    });
    runBuild(root);
    expect(await fs.readFile(path.join(root, "dist/plain/index.html"), "utf8")).not.toContain("</head>");
    expect(styles(await sheetsOf(root, "plain/index.html"))).toEqual([]);

    await fs.writeFile(path.join(root, "src/scripts/entry.js"), entryScript(`import "../../vendor/hoisted.css";\n`));
    expect(runBuild(root)).not.toMatch(/plain\.astro → .* \[cached\]/);
    expect(styles(await sheetsOf(root, "plain/index.html")).join("")).toContain(".hoisted-v1");
    await expectSameAsFullBuild(root);
  });

  test("a CSS-only change leaves dist as a full build writes it, apart from the superseded sheet", async () => {
    // Shared sheet linked (over the limit, with a url() asset), a page group inlined, a page without `</head>`.
    const hoisted = (version: string) =>
      `.hoisted-${version} { font-family: "Probe"; }\n@font-face { font-family: "Probe"; src: url(./files/probe.woff2); }\n${sheetOfSize(`pad-${version}`, 5000)}`;
    const root = await project({
      "astro.config.mjs": "export default {};\n",
      "vendor/hoisted.css": hoisted("v1"),
      "vendor/files/probe.woff2": noise(5000, 4),
      "vendor/small.css": ".small-marker { color: rgb(1, 2, 3); }\n",
      "src/scripts/entry.js": entryScript(`import "../../vendor/hoisted.css";\n`),
      "src/pages/index.astro": indexPage,
      "src/pages/about.astro": aboutPage,
      "src/pages/small.astro": page("../../vendor/small.css", ".small-page{color:blue}"),
      "src/pages/frag.astro": "<p>no head</p>\n",
    });
    runBuild(root);
    await fs.writeFile(path.join(root, "vendor/hoisted.css"), hoisted("v2"));
    expect(runBuild(root)).toContain("1 rendered + 3 cached");
    expect(await linkedCss(root, links(await sheetsOf(root, "about/index.html"))[0])).toContain(".hoisted-v2");
    expect(await expectSameAsFullBuild(root)).toHaveLength(1);
  });

  test("a pletivo-native page with an island and no CSS stays cached", async () => {
    const root = await project({
      "tsconfig.json": nativeTsconfig(),
      "src/islands/Counter.tsx": `import { useState } from "preact/hooks";\nexport default function Counter(props: { initial: number }) {\n  const [count, setCount] = useState(props.initial);\n  return <button onClick={() => setCount((c) => c + 1)}>{count}</button>;\n}\n`,
      "src/pages/index.tsx": `import Counter from "../islands/Counter";\nexport default function Home() {\n  return <html><head><title>i</title></head><body><Counter client="load" initial={0} /></body></html>;\n}\n`,
    });
    runBuild(root);
    // The hydration script follows where the stylesheet markup would go.
    expect(await fs.readFile(path.join(root, "dist/index.html"), "utf8")).toMatch(/<script[^>]*>[\s\S]*<\/head>/);
    expect(runBuild(root)).toContain("0 rendered + 1 cached");
  });

  test("only whitespace between the recorded tags is tolerated, not other markup", async () => {
    // With `never` the markup is a `<link>` then the page's `<style>`; the hook puts a comment between them.
    const root = await hookProject(`build: { inlineStylesheets: "never" }, `, String.raw`html.replace(/<style>/g, "<!--x--><style>")`);
    runBuild(root);
    expect(await fs.readFile(path.join(root, "dist/about/index.html"), "utf8")).toMatch(/<link [^>]*>\s*<!--x--><style>/);

    await fs.writeFile(path.join(root, "vendor/hoisted.css"), ".hoisted-v2 { color: blue; }\n");
    expect(runBuild(root)).not.toMatch(aboutCached);
    await expectSameAsFullBuild(root);
  });
});
