/**
 * The per-file compile cache: that a warm compile is the same complete result, and that each
 * effect the entry has to carry by hand survives a hit.
 *
 * Every one of those effects fails silently — a missing `import.meta.env` global throws
 * at frontmatter, a dropped `astro:env` name stops the isolate booting, a lost `<style>`
 * renders an unstyled page with no error at all — so each gets its own test rather than
 * riding on the complete-result comparison that would also catch it.
 */

import { describe, expect, test } from "bun:test";
import type {
  ParseOptions,
  ParseResult,
  TransformOptions,
  TransformResult,
} from "@astrojs/compiler/types";
import { createAstroCompiler, type AstroCompiler } from "../src/astro-compiler.ts";
import { createCompileCache, type CompiledFile } from "../src/compile-cache.ts";
import { compileProject, type CompiledProject } from "../src/compile-project.ts";
import { createProjectAssetsView } from "../src/content-files.ts";
import { IMPORT_META_ENV_GLOBAL } from "../src/env.ts";
import { astroWasmModule } from "./astro-wasm.ts";

const compiler = createAstroCompiler(await astroWasmModule());

/** The real compiler, with the filename of every `transform` recorded. */
function countingCompiler(): { compiler: AstroCompiler; transformed: string[] } {
  const transformed: string[] = [];
  return {
    transformed,
    compiler: {
      transform(source: string, options?: TransformOptions): Promise<TransformResult> {
        transformed.push(options?.filename ?? "");
        return compiler.transform(source, options);
      },
      // `classifyStyles` calls this; only `transform` is counted, so a style pass
      // cannot be mistaken for a recompile.
      parse(source: string, options?: ParseOptions): Promise<ParseResult> {
        return compiler.parse(source, options);
      },
    },
  };
}

/** A 4×4 PNG. Real bytes, so the header `assetInfo` reads is real. */
const PNG_4x4 = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFElEQVR4nGP8z4A" +
      "AjEwMDAwMDAwMDAAOKgIBIfBvXQAAAABJRU5ErkJggg==",
  ),
  (character) => character.charCodeAt(0),
);

const PAGE = "src/pages/index.astro";

/**
 * One page reaching every branch of the per-file compile: `.astro` with a scoped and an
 * `is:global` block, `.tsx`, `.ts`, `.js`, `.css`, a `?url` import, an imported `.png`,
 * `astro:env/server`, `import.meta.env`, and the content API.
 */
const PROJECT = new Map<string, string>([
  [
    PAGE,
    `---
import Layout from "../components/Layout.astro";
import Card from "../components/Card.tsx";
import { TITLE } from "../lib/data.ts";
import { NAME } from "../lib/name.js";
import "../styles/site.css";
import formUrl from "../scripts/form.js?url";
import logo from "../assets/logo.png";
import { API_TOKEN } from "astro:env/server";
import { getCollection } from "astro:content";
const posts = await getCollection("posts");
const where = import.meta.env.SITE;
---
<Layout title={TITLE}>
  <Card name={NAME} />
  <img src={logo.src} alt="logo" />
  <a href={formUrl}>{where}{API_TOKEN}{posts.length}</a>
</Layout>
<style>a { color: rebeccapurple; }</style>
<style is:global>body { margin: 0; }</style>
`,
  ],
  [
    "src/components/Layout.astro",
    `---
export interface Props { title: string }
const { title } = Astro.props;
---
<html><head><title>{title}</title></head><body><slot /></body></html>
<style>body { background: white; }</style>
`,
  ],
  [
    "src/components/Card.tsx",
    `export default function Card({ name }: { name: string }) {
  return <div class="card">{name}</div>;
}
`,
  ],
  ["src/lib/data.ts", `export const TITLE: string = "everything";\n`],
  ["src/lib/name.js", `export const NAME = "pletivo";\n`],
  ["src/styles/site.css", `.site { color: blue; }\n`],
  ["src/scripts/form.js", `console.log("form");\n`],
  [
    "src/content.config.ts",
    `import { defineCollection, z } from "astro:content";
export const collections = {
  posts: defineCollection({ schema: z.object({ title: z.string() }) }),
};
`,
  ],
]);

const ASSETS = new Map([["src/assets/logo.png", PNG_4x4]]);
const ASSET_VIEW = createProjectAssetsView(ASSETS);

function build(
  files: ReadonlyMap<string, string>,
  cache?: ReturnType<typeof createCompileCache>,
  built: AstroCompiler = compiler,
): Promise<CompiledProject> {
  return compileProject({
    files,
    entries: [PAGE],
    assets: ASSET_VIEW,
    srcDir: "src",
    compiler: built,
    cache,
  });
}

/** A file's source, made equal to the original but not the same object. */
function copyOf(source: string): string {
  return (" " + source).slice(1);
}

describe("a warm cache", () => {
  test("produces the identical compiled project", async () => {
    const cache = createCompileCache();
    const cold = await build(PROJECT, cache);
    const warm = await build(PROJECT, cache);

    expect(warm).toEqual(cold);
  });

  test("recompiles only the file that changed", async () => {
    const cache = createCompileCache();
    const counting = countingCompiler();

    await build(PROJECT, cache, counting.compiler);
    expect(counting.transformed).toEqual([PAGE, "src/components/Layout.astro"]);

    counting.transformed.length = 0;
    await build(PROJECT, cache, counting.compiler);
    expect(counting.transformed).toEqual([]);

    // One edit, and the page that imports it is *not* recompiled: its own bytes did
    // not move, and nothing in an entry depends on what it imports.
    const edited = new Map(PROJECT);
    edited.set("src/components/Layout.astro", `<html><body><slot /></body></html>\n`);
    counting.transformed.length = 0;
    await build(edited, cache, counting.compiler);
    expect(counting.transformed).toEqual(["src/components/Layout.astro"]);
  });

  test("does not reuse the same text at a different path", async () => {
    // The compiler's scope hash is a function of the filename, so one entry serving two
    // paths would give both components one scope and leak their styles into each other.
    const source = `<p>x</p>\n<style>p { color: red; }</style>\n`;
    const files = new Map([
      ["src/pages/a.astro", source],
      ["src/pages/b.astro", source],
    ]);
    const cache = createCompileCache();
    const counting = countingCompiler();
    const options = { files, assets: ASSET_VIEW, srcDir: "src", compiler: counting.compiler, cache };

    const a = await compileProject({ ...options, entries: ["src/pages/a.astro"] });
    const b = await compileProject({ ...options, entries: ["src/pages/b.astro"] });

    expect(counting.transformed).toEqual(["src/pages/a.astro", "src/pages/b.astro"]);
    expect(a.styles.get("src/pages/a.astro")?.scope).not.toBe(
      b.styles.get("src/pages/b.astro")?.scope,
    );
  });

  test("hits on an equal string that is not the identical one", async () => {
    // `===` on strings is JavaScript value equality; the identity a revision gate hands
    // back is the fast path, not the check. So a store that re-reads unchanged bytes
    // still hits — it pays a comparison instead of a pointer, which is the whole reason
    // hashing was not needed.
    const cache = createCompileCache();
    const counting = countingCompiler();
    const cold = await build(PROJECT, cache, counting.compiler);

    const copied = new Map<string, string>();
    for (const [file, source] of PROJECT) copied.set(file, copyOf(source));
    counting.transformed.length = 0;
    const warm = await build(copied, cache, counting.compiler);

    expect(counting.transformed).toEqual([]);
    expect(warm).toEqual(cold);
  });

  test("misses again once the entry is deleted", async () => {
    const cache = createCompileCache();
    const counting = countingCompiler();
    await build(PROJECT, cache, counting.compiler);

    cache.delete("src/components/Layout.astro");
    counting.transformed.length = 0;
    await build(PROJECT, cache, counting.compiler);

    expect(counting.transformed).toEqual(["src/components/Layout.astro"]);
  });
});

describe("what a cache entry has to carry", () => {
  /** One cold compile and one warm one, through the same cache. */
  async function twice(): Promise<{ cold: CompiledProject; warm: CompiledProject }> {
    const cache = createCompileCache();
    return { cold: await build(PROJECT, cache), warm: await build(PROJECT, cache) };
  }

  test("import.meta.env survives, so the entry still installs the global", async () => {
    const { warm } = await twice();
    // Missed on a hit, the page would throw at frontmatter with the substitution still
    // in the module and nothing answering it.
    expect(warm.importMetaEnv).toBe(true);
    expect(warm.modules[warm.moduleNames.get(PAGE) ?? ""]).toContain(
      `globalThis.${IMPORT_META_ENV_GLOBAL}`,
    );
  });

  test("the astro:env names survive, so the generated module still exports them", async () => {
    const { warm } = await twice();
    // A dropped name is `SyntaxError: does not provide an export named 'API_TOKEN'`,
    // and the isolate refuses to start.
    expect(warm.env).toEqual({ client: null, server: ["API_TOKEN"] });
  });

  test("the <style> blocks survive, scope included", async () => {
    const { cold, warm } = await twice();
    const scope = warm.styles.get(PAGE)?.scope;

    expect(warm.styles.get(PAGE)?.blocks).toEqual([
      { global: false, css: `a:where(.astro-${scope}){color:rebeccapurple}` },
      { global: true, css: "body { margin: 0; }" },
    ]);
    expect(warm.styles.get("src/components/Layout.astro")).toEqual(
      cold.styles.get("src/components/Layout.astro"),
    );
    // The scope the HTML carries and the scope the CSS was written for are one value.
    expect(warm.modules[warm.moduleNames.get(PAGE) ?? ""]).toContain(`astro-${scope}`);
  });

  test("a .css file still contributes a stylesheet edge and no import edge", async () => {
    const { warm } = await twice();
    expect(warm.cssImports.get(PAGE)).toEqual(["src/styles/site.css"]);
    expect(warm.imports.get(PAGE)).not.toContain("src/styles/site.css");
    // CSS owns an explicit empty execution list; its own @imports, if any, are style edges.
    expect(warm.imports.get("src/styles/site.css")).toEqual([]);
  });

  test("a .js file keeps its edges and its substituted code together", async () => {
    // The specifiers are read off the pre-substitution text and the rewrite runs over
    // the post-substitution one. Nothing in the output can tell those two texts apart —
    // substitution touches no import — so this pins the pairing rather than the split.
    const files = new Map(PROJECT);
    files.set(
      "src/lib/name.js",
      `import "../styles/site.css";\nexport const NAME = import.meta.env.NAME;\n`,
    );
    const cache = createCompileCache();
    const cold = await build(files, cache);
    const warm = await build(files, cache);

    expect(warm.cssImports.get("src/lib/name.js")).toEqual(["src/styles/site.css"]);
    expect(warm.modules[warm.moduleNames.get("src/lib/name.js") ?? ""]).toBe(
      cold.modules[cold.moduleNames.get("src/lib/name.js") ?? ""],
    );
    expect(warm.importMetaEnv).toBe(true);
  });

  test("the effects that ride on resolve are free", async () => {
    // The claim the whole design rests on: `rewriteImports` runs on a hit too, so
    // everything `resolve` does happens again without being stored.
    const { cold, warm } = await twice();

    expect(warm.content).toEqual({ configModule: cold.content?.configModule ?? null });
    expect(warm.content?.configModule).toBeString();
    expect(warm.images).toBe(true);
    expect(warm.urlAssets).toEqual(cold.urlAssets);
    expect([...warm.urlAssets.keys()]).toEqual([expect.stringMatching(/^\/_astro\/form\./)]);
    // The image metadata module is written inside `resolve` and carried by nothing.
    const logo = warm.moduleNames.get("src/assets/logo.png") ?? "";
    expect(warm.modules[logo]).toBe(cold.modules[logo]);
    expect(warm.modules[logo]).toContain(`"width":4`);
  });

  test("refreshes image metadata without recompiling a warm importer", async () => {
    const cache = createCompileCache();
    const counting = countingCompiler();
    const firstAssets = createProjectAssetsView(new Map([
      ["src/assets/logo.png", { width: 4, height: 4, format: "png", hash: "11111111" }],
    ]));
    const secondAssets = createProjectAssetsView(new Map([
      ["src/assets/logo.png", { width: 8, height: 6, format: "png", hash: "22222222" }],
    ]));
    const options = {
      files: PROJECT,
      entries: [PAGE],
      srcDir: "src",
      compiler: counting.compiler,
      cache,
    };

    const cold = await compileProject({ ...options, assets: firstAssets });
    counting.transformed.length = 0;
    const warm = await compileProject({ ...options, assets: secondAssets });
    const coldLogo = cold.modules[cold.moduleNames.get("src/assets/logo.png") ?? ""];
    const warmLogo = warm.modules[warm.moduleNames.get("src/assets/logo.png") ?? ""];

    expect(counting.transformed).toEqual([]);
    expect(coldLogo).toContain('/_astro/logo.11111111.png');
    expect(warmLogo).toContain('/_astro/logo.22222222.png');
    expect(warmLogo).toContain('"width":8');
    expect(warmLogo).toContain('"height":6');
    expect(warmLogo).not.toBe(coldLogo);
  });

  test("a file the compiler rejects is not cached", async () => {
    const files = new Map([["src/pages/broken.astro", "<slot name/>"]]);
    const cache = createCompileCache();
    const broken = { files, entries: ["src/pages/broken.astro"], compiler, cache };

    expect(compileProject(broken)).rejects.toThrow(/slot\[name\] must be a static string/);
    expect(compileProject(broken)).rejects.toThrow(/slot\[name\] must be a static string/);
    expect(cache.get("src/pages/broken.astro")).toBeUndefined();
    expect(cache.bytes).toBe(0);
  });
});

describe("createCompileCache, the bound", () => {
  function entryOf(source: string, code: string | null = null): CompiledFile {
    return { source, code, importMetaEnv: false, specifiers: [], envNames: null, styles: null };
  }

  test("charges the source, the code, the specifiers and the style bytes", () => {
    const cache = createCompileCache();
    cache.set("a.js", entryOf("12345", "678"));
    expect(cache.bytes).toBe(8);

    cache.set("b.astro", {
      ...entryOf("1234"),
      specifiers: ["./x"],
      styles: { scope: "abcd", blocks: [{ global: false, css: "p{}" }] },
    });
    expect(cache.bytes).toBe(8 + 4 + 3 + 4 + 3);
  });

  test("re-setting a file replaces its charge rather than adding to it", () => {
    const cache = createCompileCache();
    cache.set("a.js", entryOf("12345"));
    cache.set("a.js", entryOf("12"));
    expect(cache.bytes).toBe(2);
  });

  test("evicts the least recently used entry", () => {
    const cache = createCompileCache({ maxEntries: 2 });
    cache.set("a.js", entryOf("a"));
    cache.set("b.js", entryOf("b"));
    // `a` was set first, and this is what makes it the most recent instead.
    expect(cache.get("a.js")).toBeDefined();
    cache.set("c.js", entryOf("c"));

    expect(cache.get("b.js")).toBeUndefined();
    expect(cache.get("a.js")).toBeDefined();
    expect(cache.get("c.js")).toBeDefined();
  });

  test("evicts from the front while over the byte budget", () => {
    const cache = createCompileCache({ maxBytes: 10 });
    cache.set("a.js", entryOf("aaaaa"));
    cache.set("b.js", entryOf("bbbbb"));
    cache.set("c.js", entryOf("ccccc"));

    expect(cache.get("a.js")).toBeUndefined();
    expect(cache.bytes).toBe(10);
  });

  test("refuses an entry that would not fit on its own", () => {
    // One enormous vendored bundle must not flush the cache and then evict itself.
    const cache = createCompileCache({ maxBytes: 10 });
    cache.set("small.js", entryOf("aaa"));
    cache.set("huge.js", entryOf("x".repeat(64)));

    expect(cache.get("huge.js")).toBeUndefined();
    expect(cache.get("small.js")).toBeDefined();
    expect(cache.bytes).toBe(3);
  });

  test("delete drops the entry and its charge", () => {
    const cache = createCompileCache();
    cache.set("a.js", entryOf("aaaaa"));
    cache.delete("a.js");
    cache.delete("never-held.js");

    expect(cache.get("a.js")).toBeUndefined();
    expect(cache.bytes).toBe(0);
  });
});
