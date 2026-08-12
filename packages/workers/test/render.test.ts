import { afterAll, describe, expect, test } from "bun:test";
import { createAstroCompiler } from "../src/astro-compiler.ts";
import {
  RouteNotFoundError,
  UnsupportedRouteError,
  bundleHash,
  projectRoutes,
  renderPage,
  typescriptSuspects,
} from "../src/render.ts";
import { astroWasmModule } from "./astro-wasm.ts";
import { FileLoader } from "./file-loader.ts";

const compiler = createAstroCompiler(await astroWasmModule());
const loader = new FileLoader();
afterAll(() => loader.cleanup());

const SITE = new Map<string, string>([
  [
    "src/components/Layout.astro",
    `---
import Note from "./Note.astro";
const { title } = Astro.props;
---
<html lang="en">
  <head><title>{title}</title></head>
  <body><h1>{title}</h1><Note /><slot /></body>
</html>
<style>body { margin: 0; }</style>
`,
  ],
  ["src/components/Note.astro", `<p class="note">note</p>\n<style>.note { color: red; }</style>\n`],
  [
    "src/pages/index.astro",
    `---
import Layout from "../components/Layout.astro";
import { NAME } from "../lib/name.js";
---
<Layout title="Home"><p>{NAME} at {Astro.url.pathname}</p></Layout>
`,
  ],
  ["src/lib/name.js", `export const NAME = "pletivo";\n`],
  ["src/pages/about.md", "---\ntitle: About\n---\n\n# About\n\ntext\n"],
  ["src/pages/plain.astro", `<html><body><p>plain</p></body></html>\n`],
  ["src/pages/blog/[slug].astro", `<html><body><p>post</p></body></html>\n`],
  [
    "src/pages/tsx.tsx",
    `import Note from "../components/Note.astro";

interface Props {
  __pageContext: { url: URL };
}

export default function Page({ __pageContext }: Props) {
  return (
    <html lang="en">
      <head><title>tsx</title></head>
      <body>
        <Note />
        <p>{__pageContext.url.pathname}</p>
        <style>{".hoisted { color: teal; }"}</style>
      </body>
    </html>
  );
}
`,
  ],
  ["src/pages/notes.mdx", "# notes\n"],
]);

const render = (pathname: string) => renderPage({ files: SITE, pathname, loader, compiler });

describe("projectRoutes", () => {
  test("takes only page files under the pages directory, static routes first", () => {
    expect(projectRoutes(SITE).map((route) => route.file)).toEqual([
      "index.astro",
      "about.md",
      "plain.astro",
      "tsx.tsx",
      "notes.mdx",
      "blog/[slug].astro",
    ]);
  });

  test("ignores files outside the pages directory", () => {
    expect(projectRoutes(SITE).some((route) => route.file.includes("Layout"))).toBe(false);
  });
});

describe("renderPage, .astro through the Worker Loader", () => {
  test("renders the page, its layout and a nested component", async () => {
    const page = await render("/");
    expect(page.file).toBe("src/pages/index.astro");
    expect(page.html).toContain("<h1");
    expect(page.html).toContain("Home");
    expect(page.html).toContain("<p>pletivo at /</p>");
    expect(page.html).toContain('<p class="note');
  });

  test("gives the document a doctype", async () => {
    expect((await render("/")).html.startsWith("<!DOCTYPE html>\n<html")).toBe(true);
  });

  test("injects the page's CSS into the head, deepest component first", async () => {
    const { html } = await render("/");
    const style = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
    expect(style).toContain(".note");
    expect(style).toContain("body{margin:0}");
    expect(style.indexOf(".note")).toBeLessThan(style.indexOf("body{margin:0}"));
  });

  test("leaves a page with no styles alone", async () => {
    const { html } = await render("/plain");
    expect(html).toBe("<!DOCTYPE html>\n<html><body><p>plain</p></body></html>");
  });

  test("hands the isolate one bundle for the whole project", async () => {
    const page = await render("/");
    const bundle = loader.bundles.get(page.bundleId);
    expect(bundle?.mainModule).toBe("pletivo-entry.js");
    expect(bundle?.compatibilityFlags).toEqual(["nodejs_compat"]);
    expect(Object.keys(bundle?.modules ?? {})).toContain("pletivo-runtime.js");
  });

  test("addresses the bundle by content, so identical sources reuse the isolate", async () => {
    const first = await render("/");
    const second = await render("/plain");
    expect(first.bundleId).toBe(second.bundleId);
  });
});

describe("renderPage, .md on the host", () => {
  test("matches what build.ts emits for a markdown page", async () => {
    const page = await render("/about");
    expect(page.file).toBe("src/pages/about.md");
    expect(page.html).toBe(
      '<!DOCTYPE html><html><head><meta charset="utf-8"><title>About</title></head>' +
        '<body><h1 id="about">About</h1>\n<p>text</p></body></html>',
    );
  });

  test("never reaches the isolate", async () => {
    expect((await render("/about")).bundleId).toBe("");
  });
});

describe("renderPage, .tsx through the Worker Loader", () => {
  test("compiles the JSX and renders the .astro component it imports", async () => {
    const page = await render("/tsx");
    expect(page.file).toBe("src/pages/tsx.tsx");
    expect(page.html).toContain("<title>tsx</title>");
    expect(page.html).toContain('<p class="note');
    expect(page.html).toContain("<p>/tsx</p>");
  });

  test("hoists a TSX <style> into the head, after the component CSS", async () => {
    // Both halves of the runtime have to share one render-tracking store for this:
    // `pushTsxStyle` writes into the store `runWithRenderTracking` opened, and a
    // second copy of render-context.ts would drop the block on the floor.
    const { html } = await render("/tsx");
    expect(html).not.toContain("<style>.hoisted");
    const style = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
    expect(style).toContain(".note");
    expect(style).toContain(".hoisted { color: teal; }");
    expect(style.indexOf(".note")).toBeLessThan(style.indexOf(".hoisted"));
  });

  test("resolves the JSX runtime inside the bundle, not from a package", async () => {
    const page = await render("/tsx");
    const modules = loader.bundles.get(page.bundleId)?.modules ?? {};
    expect(Object.keys(modules)).toContain("pletivo-jsx-runtime.js");
    expect(modules["src_pages_tsx.tsx.js"]).toContain('"./pletivo-jsx-runtime.js"');
    expect(modules["src_pages_tsx.tsx.js"]).not.toContain('"pletivo/jsx-runtime"');
  });
});

describe("renderPage, refusals", () => {
  test("reports an unmatched pathname", () => {
    expect(render("/nope")).rejects.toBeInstanceOf(RouteNotFoundError);
  });

  test("refuses a page kind it has no compiler for", () => {
    expect(render("/notes")).rejects.toThrow(/only \.astro, \.tsx and \.md pages render here/);
  });

  test("refuses a dynamic route rather than guessing its params", () => {
    expect(render("/blog/hello")).rejects.toBeInstanceOf(UnsupportedRouteError);
  });
});

describe("bundleHash", () => {
  test("depends on names and sources, not on key order", async () => {
    const a = await bundleHash({ "a.js": "1", "b.js": "2" });
    expect(await bundleHash({ "b.js": "2", "a.js": "1" })).toBe(a);
    expect(await bundleHash({ "a.js": "1", "b.js": "3" })).not.toBe(a);
    expect(await bundleHash({ "a.js": "1", "c.js": "2" })).not.toBe(a);
  });
});

describe("typescriptSuspects", () => {
  test("names the modules carrying TypeScript", () => {
    expect(
      typescriptSuspects({
        "Card.astro.js": "export interface Props {\n  title: string;\n}\n",
        "Kind.astro.js": "type Kind = 'a' | 'b';\n",
        "Level.astro.js": "export enum Level { Low }\n",
        "Api.astro.js": "declare const api: unknown;\n",
      }),
    ).toEqual(["Api.astro.js", "Card.astro.js", "Kind.astro.js", "Level.astro.js"]);
  });

  test("does not read prose or strings as syntax", () => {
    // The isolate fails identically on an unresolvable specifier, and blaming
    // TypeScript there sends the reader hunting for annotations that do not exist.
    expect(
      typescriptSuspects({
        "Doc.astro.js": `const help = "declare the interface first";\n// type Foo = never\n`,
        "Page.astro.js": `import x from "./missing.js";\nexport default x;\n`,
      }),
    ).toEqual([]);
  });
});
