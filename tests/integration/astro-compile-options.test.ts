import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import path from "path";
import fs from "fs/promises";
import { pathToFileURL } from "url";
import { transform } from "@astrojs/compiler";
import { build } from "../../packages/pletivo/src/build";
import { __resetForTests } from "../../packages/pletivo/src/astro-host/runner";
import type { PletivoConfig } from "../../packages/pletivo/src/config";
import { normalizeFilename, normalizeRootRelativeFilename, resolveCompressHTML } from "@pletivo/core/astro-host/compile-options";
import type { AstroConfig } from "@pletivo/core/astro-host/types";

// `.astro` compiles with Astro's options: `compact` from `compressHTML` (default true) and a
// root-relative `normalizedFilename`, hashed into the scope id. Both fixtures hold the same
// `src/components/Subject.astro`; one sets `compressHTML: false`.
const compressedRoot = path.join(import.meta.dir, "../fixture-astro-compile-options");
const uncompressedRoot = path.join(import.meta.dir, "../fixture-astro-compile-options-uncompressed");
const SUBJECT = "src/components/Subject.astro";

const config: PletivoConfig = {
  host: "localhost",
  outDir: "dist",
  port: 3000,
  base: "/",
  srcDir: "src",
  publicDir: "public",
};

/** What Astro 5 renders for the component: the options its compiler call passes that this compiler accepts. */
async function astroCompile(root: string, compact: boolean): Promise<{ html: string; scope: string }> {
  const filename = path.join(root, SUBJECT);
  const result = await transform(await Bun.file(filename).text(), {
    compact,
    filename,
    normalizedFilename: `/${SUBJECT}`,
    internalURL: "astro/compiler-runtime",
    scopedStyleStrategy: "attribute",
    resultScopedSlot: true,
    transitionsAnimationURL: "astro/components/viewtransitions.css",
  });
  const template = /\$\$render`([\s\S]*?)`;/.exec(result.code)?.[1];
  if (template === undefined) throw new Error(`no render template in the compiled ${SUBJECT}`);
  // The page renders <head> itself, so the component's head marker renders nothing.
  const html = template.replace("${$$maybeRenderHead($$result)}", "");
  if (html.includes("${")) throw new Error(`the fixture's template has an expression: ${html}`);
  return { html, scope: result.scope };
}

async function buildSubject(root: string): Promise<{ page: string; subject: string }> {
  __resetForTests();
  await build(root, config);
  const page = await Bun.file(path.join(root, "dist/index.html")).text();
  const open = '<main id="subject">';
  const start = page.indexOf(open);
  const end = page.lastIndexOf("</main>");
  if (start === -1 || end === -1) throw new Error(`no <main id="subject"> in the page: ${page}`);
  return { page, subject: page.slice(start + open.length, end) };
}

describe("Astro project .astro compile options", () => {
  let compressed: { page: string; subject: string };
  let uncompressed: { page: string; subject: string };

  beforeAll(async () => {
    compressed = await buildSubject(compressedRoot);
    uncompressed = await buildSubject(uncompressedRoot);
  });

  afterAll(async () => {
    __resetForTests();
    await fs.rm(path.join(compressedRoot, "dist"), { recursive: true, force: true });
    await fs.rm(path.join(uncompressedRoot, "dist"), { recursive: true, force: true });
  });

  test("compressHTML defaults to true and collapses whitespace as Astro's compile does", async () => {
    const astro = await astroCompile(compressedRoot, true);
    expect(astro.html).toBe(
      '<section class="subject" data-astro-cid-t7m3ubvd> <h2 data-astro-cid-t7m3ubvd> Title </h2> ' +
        '<p data-astro-cid-t7m3ubvd>\nSome   text\n    here.\n</p> </section>',
    );
    expect(compressed.subject).toBe(astro.html);
  });

  test("compressHTML: false keeps the whitespace", async () => {
    const astro = await astroCompile(uncompressedRoot, false);
    expect(astro.html).toBe(
      '<section class="subject" data-astro-cid-t7m3ubvd>\n  <h2 data-astro-cid-t7m3ubvd>   Title   </h2>\n' +
        '  <p data-astro-cid-t7m3ubvd>\n    Some   text\n    here.\n  </p>\n</section>',
    );
    expect(uncompressed.subject).toBe(astro.html);
  });

  test("the scope id is the one Astro computes for the root-relative path", async () => {
    const { scope } = await astroCompile(compressedRoot, true);
    expect(scope).toBe("t7m3ubvd");
    for (const { page } of [compressed, uncompressed]) {
      expect(page).toContain(`<section class="subject" data-astro-cid-${scope}>`);
      expect(page).toContain(`.subject[data-astro-cid-${scope}]{color:red}`);
    }
  });
});

describe("normalizeFilename", () => {
  const root = pathToFileURL("/projects/site/");

  test("is root-relative with a leading slash inside the root", () => {
    expect(normalizeFilename("/projects/site/src/pages/index.astro", root)).toBe("/src/pages/index.astro");
    expect(normalizeFilename("/projects/site/src/../src/a.astro", root)).toBe("/src/a.astro");
  });

  test("is root-relative from `../` outside the root, unlike Astro's absolute path", () => {
    expect(normalizeFilename("/projects/shared/./Card.astro", root)).toBe("../shared/Card.astro");
    expect(normalizeFilename("/projects/node_modules/ui/Card.astro", root)).toBe("../node_modules/ui/Card.astro");
    // A sibling whose name only starts with the root's is outside it.
    expect(normalizeFilename("/projects/site-ui/Card.astro", root)).toBe("../site-ui/Card.astro");
  });

  test("equals what the Workers host derives from the root-relative compile path", () => {
    for (const file of ["/projects/site/src/pages/index.astro", "/projects/node_modules/ui/Card.astro"]) {
      const compilePath = path.relative("/projects/site", file);
      expect(normalizeFilename(file, root)).toBe(normalizeRootRelativeFilename(compilePath));
    }
  });
});

describe("resolveCompressHTML", () => {
  function astroConfig(extra: Record<string, unknown>): AstroConfig {
    const root = new URL("file:///site/");
    return {
      root,
      srcDir: root,
      publicDir: root,
      outDir: root,
      base: "/",
      trailingSlash: "ignore",
      build: { format: "directory", client: root, server: root, assets: "_astro" },
      integrations: [],
      vite: {},
      redirects: {},
      ...extra,
    };
  }

  test("leaves a pletivo-native project to the compiler's default", () => {
    expect(resolveCompressHTML(undefined)).toBeUndefined();
  });

  test("follows the config, defaulting to true", () => {
    expect(resolveCompressHTML(astroConfig({}))).toBe(true);
    expect(resolveCompressHTML(astroConfig({ compressHTML: false }))).toBe(false);
  });

  test("rejects a value that is not a boolean, naming the config", () => {
    expect(() => resolveCompressHTML(astroConfig({ compressHTML: "yes" }))).toThrow('astro.config: compressHTML "yes" is not a boolean');
  });
});
