import { afterAll, describe, expect, test } from "bun:test";
import { ANY_PROJECT_IMPORTER, ARTIFACT_VERSION, type ArtifactMdxConfig } from "@pletivo/core/artifact";
import { loadProjectArtifact } from "../src/artifact.ts";
import { createAstroCompiler } from "../src/astro-compiler.ts";
import { createCompileCache } from "../src/compile-cache.ts";
import { MdxNotPreparedError } from "../src/mdx-isolate.ts";
import { UnsupportedFileError } from "../src/compile-project.ts";
import { renderPage } from "../src/render.ts";
import { astroWasmModule } from "./astro-wasm.ts";
import { FileLoader } from "./file-loader.ts";

/**
 * `.mdx` pages on the Workers host: compiled in the MDX isolate, beside the project's plugins,
 * and rendered in the render isolate. `fixture-parity.test.ts` compares the bytes with
 * `pletivo build`; this is what parity cannot show.
 */

const compiler = createAstroCompiler(await astroWasmModule());
const loader = new FileLoader();
afterAll(() => loader.cleanup());

const PLUGINS = `const PORTABLE = Symbol.for("pletivo.portableModule");
function visit(node, fn) {
  fn(node);
  for (const child of node.children ?? []) visit(child, fn);
}
export function remarkShout(options = {}) {
  return (tree) => visit(tree, (node) => { if (node.type === "text") node.value += options.suffix ?? ""; });
}
export function rehypeMark() {
  return (tree) => visit(tree, (node) => {
    if (node.type === "element" && node.tagName === "p") node.properties = { ...node.properties, className: ["marked"] };
  });
}
`;

function artifact(mdx: ArtifactMdxConfig | undefined) {
  return loadProjectArtifact({
    artifact: {
      version: ARTIFACT_VERSION,
      config: mdx === undefined ? {} : { mdx },
      scripts: { headInline: [], page: [] },
      modules: [{ id: "npm:portable-markdown/index.js", kind: "js", source: PLUGINS }],
      resolutions: [
        {
          importer: ANY_PROJECT_IMPORTER,
          specifier: "portable-markdown",
          target: { kind: "module", id: "npm:portable-markdown/index.js" },
        },
      ],
    },
  });
}

const WITH_PLUGINS: ArtifactMdxConfig = {
  remarkPlugins: [{ module: "portable-markdown", export: "remarkShout", options: { suffix: "!" } }],
  rehypePlugins: [{ module: "portable-markdown", export: "rehypeMark" }],
  gfm: true,
  astro: { experimentalHeadingIdCompat: false },
};

const PAGE = `---
title: ignored
---
import Badge from "../components/Badge.astro";
export const who = "MDX";

# Hello {who}

Plain ~~struck~~ text.

<Badge label="component" />
`;

const FILES: ReadonlyArray<[string, string]> = [
  ["src/pages/index.mdx", PAGE],
  ["src/components/Badge.astro", "---\nconst { label } = Astro.props;\n---\n<span class=\"badge\">{label}</span>\n"],
];

describe(".mdx pages on the Workers host", () => {
  test("compile and render in the isolate, with GFM, expressions and an imported .astro component", async () => {
    const page = await renderPage({ files: new Map(FILES), pathname: "/", loader, compiler });
    expect(page.html).toContain("<h1>Hello MDX</h1>");
    expect(page.html).toContain("<del>struck</del>");
    expect(page.html).toContain('<span class="badge">component</span>');
    expect(page.html).not.toContain("title: ignored");
  }, 60_000);

  test("run the project's remark and rehype plugins, and @astrojs/mdx's Astro additions", async () => {
    const page = await renderPage({ files: new Map(FILES), pathname: "/", loader, compiler, artifact: artifact(WITH_PLUGINS) });
    expect(page.html).toContain('<h1 id="hello-who">Hello !MDX</h1>');
    expect(page.html).toContain('<p class="marked">Plain !<del>struck!</del> text.!</p>');
    expect(page.html).toContain('<meta charset="utf-8">');
  }, 60_000);

  test("stay live: an edit re-renders with the same artifact and compile cache", async () => {
    const cache = createCompileCache();
    const options = { pathname: "/", loader, compiler, artifact: artifact(WITH_PLUGINS), compileCache: cache };
    const before = await renderPage({ ...options, files: new Map(FILES) });
    expect(before.html).toContain("Hello !MDX");
    const edited = new Map(FILES);
    edited.set("src/pages/index.mdx", PAGE.replace("# Hello {who}", "# Edited {who}"));
    const after = await renderPage({ ...options, files: edited });
    expect(after.html).toContain('<h1 id="edited-who">Edited !MDX</h1>');
    expect(after.bundleId).not.toBe(before.bundleId);
  }, 60_000);

  test("need an artifact prepared with them", async () => {
    await expect(
      renderPage({ files: new Map(FILES), pathname: "/", loader, compiler, artifact: artifact(undefined) }),
    ).rejects.toBeInstanceOf(MdxNotPreparedError);
  }, 60_000);

  test("name the file a compile fails in", async () => {
    const broken = new Map(FILES);
    broken.set("src/pages/index.mdx", "# Broken\n\n<Unclosed>\n");
    const error = await renderPage({ files: broken, pathname: "/", loader, compiler }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UnsupportedFileError);
    expect(String(error)).toContain("src/pages/index.mdx");
    expect(String(error)).toContain("MDX compilation failed");
  }, 60_000);
});
