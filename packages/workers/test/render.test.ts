import { afterAll, describe, expect, test } from "bun:test";
import { createAstroCompiler, type AstroCompiler } from "../src/astro-compiler.ts";
import {
  RouteNotFoundError,
  RoutePathNotFoundError,
  UnsupportedRouteError,
  bundleHash,
  projectPaths,
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

  test("hands the isolate one bundle, entered at the generated module", async () => {
    const page = await render("/");
    const bundle = loader.bundles.get(page.bundleId);
    expect(bundle?.mainModule).toBe("pletivo-entry.js");
    expect(bundle?.compatibilityFlags).toEqual(["nodejs_compat"]);
    expect(Object.keys(bundle?.modules ?? {})).toContain("pletivo-runtime.js");
  });

  test("addresses the bundle by content, so the same page reuses the isolate", async () => {
    expect((await render("/")).bundleId).toBe((await render("/")).bundleId);
  });

  test("gives two pages that share no module two bundles", async () => {
    // The cost of pruning the compile to the page: one project is no longer one
    // isolate. Recorded rather than prevented — see docs/todos/023 §10, and the other
    // side of it, which is that a write only cools the pages that reach the file.
    expect((await render("/")).bundleId).not.toBe((await render("/plain")).bundleId);
  });

  test("compiles only what the page reaches, so a sibling page is not in its bundle", async () => {
    const page = await render("/plain");
    const modules = Object.keys(loader.bundles.get(page.bundleId)?.modules ?? {});
    expect(modules).toContain("src_pages_plain.astro.js");
    expect(modules).not.toContain("src_pages_index.astro.js");
    expect(modules).not.toContain("src_components_Layout.astro.js");
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

/**
 * The three kinds of dynamic route the Bun host has, in one project.
 *
 * `tests/fixture-on-demand-routes` encodes the same three for the Bun dev server, and
 * the intent is the same here: an enumerable route renders only what it listed,
 * `prerender = false` renders whatever the URL says, and a route that declares
 * neither stays a 404 — the last one is the guard that stops the on-demand branch
 * from swallowing every unresolvable route.
 */
const DYNAMIC = new Map<string, string>([
  ["src/pages/index.astro", `<html><body><p>home</p></body></html>\n`],
  [
    "src/pages/posts/[slug].astro",
    `---
export async function getStaticPaths() {
  return [
    { params: { slug: "hello" }, props: { title: "Hello", body: "first" } },
    { params: { slug: "world" }, props: { title: "World", body: "second" } },
  ];
}
const { title, body } = Astro.props;
---
<html><head><title>{title}</title></head><body><p id="body">{body}</p><p id="slug">{Astro.params.slug}</p></body></html>
`,
  ],
  [
    "src/pages/list/[...page].astro",
    `---
export async function getStaticPaths({ paginate }) {
  return paginate(["a", "b", "c"], { pageSize: 2 });
}
const { page } = Astro.props;
---
<html><body><p id="items">{page.data.join(",")}</p><p id="n">{page.currentPage}/{page.lastPage}</p><p id="next">{page.url.next}</p></body></html>
`,
  ],
  [
    "src/pages/live/[slug].astro",
    `---
export const prerender = false;
const { slug } = Astro.params;
---
<html><body><p id="slug">{slug}</p><p id="path">{Astro.url.pathname}</p></body></html>
`,
  ],
  [
    "src/pages/mystery/[slug].astro",
    `---
const { slug } = Astro.params;
---
<html><body><p id="slug">{slug}</p></body></html>
`,
  ],
  [
    "src/pages/entry/[id].astro",
    `---
export async function getStaticPaths() {
  return [
    {
      params: { id: "one" },
      props: { entry: { title: "One", render: async () => "<em>rendered</em>" } },
    },
  ];
}
const { entry } = Astro.props;
const body = await entry.render();
---
<html><body><h1>{entry.title}</h1><div set:html={body}></div></body></html>
`,
  ],
  [
    "src/pages/tag/[name].tsx",
    `export function getStaticPaths() {
  return [{ params: { name: "css" }, props: { count: 3 } }];
}

export default function Tag({ count, __pageContext }) {
  return (
    <html>
      <body>
        <p id="count">{count}</p>
        <p id="name">{__pageContext.params.name}</p>
      </body>
    </html>
  );
}
`,
  ],
]);

const renderDynamic = (pathname: string) =>
  renderPage({ files: DYNAMIC, pathname, loader, compiler });

/** The error a render threw. Fails the test when the render succeeded instead. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the render to be rejected, and it resolved");
}

describe("renderPage, getStaticPaths routes", () => {
  test("renders a listed path with the props that path carries", async () => {
    const page = await renderDynamic("/posts/world");
    expect(page.file).toBe("src/pages/posts/[slug].astro");
    expect(page.html).toContain("<title>World</title>");
    expect(page.html).toContain('<p id="body">second</p>');
  });

  test("gives Astro.params the params of the matched path", async () => {
    expect((await renderDynamic("/posts/hello")).html).toContain('<p id="slug">hello</p>');
  });

  test("404s a path getStaticPaths did not list", async () => {
    const error = await rejection(renderDynamic("/posts/nope"));
    expect(error).toBeInstanceOf(RoutePathNotFoundError);
    expect(error).toMatchObject({
      reason: "no-static-path",
      pathname: "/posts/nope",
      file: "src/pages/posts/[slug].astro",
    });
  });

  test("keeps props that cannot be serialized inside the isolate", async () => {
    // The whole reason this is one call: a collection-backed route's props hold a
    // `render()` method, which no JSON boundary would survive.
    const { html } = await renderDynamic("/entry/one");
    expect(html).toContain("<h1>One</h1>");
    expect(html).toContain("<div><em>rendered</em></div>");
  });

  test("hands a .tsx page its props as plain props, not as a render result", async () => {
    const { html } = await renderDynamic("/tag/css");
    expect(html).toContain('<p id="count">3</p>');
    expect(html).toContain('<p id="name">css</p>');
  });
});

describe("renderPage, paginate()", () => {
  test("serves the first page at the unnumbered URL", async () => {
    const { html } = await renderDynamic("/list");
    expect(html).toContain('<p id="items">a,b</p>');
    expect(html).toContain('<p id="n">1/2</p>');
    expect(html).toContain('<p id="next">/list/2/</p>');
  });

  test("serves the numbered pages", async () => {
    const { html } = await renderDynamic("/list/2");
    expect(html).toContain('<p id="items">c</p>');
    expect(html).toContain('<p id="n">2/2</p>');
  });

  test("404s past the last page", async () => {
    expect(await rejection(renderDynamic("/list/3"))).toBeInstanceOf(RoutePathNotFoundError);
  });
});

describe("renderPage, prerender = false", () => {
  test("renders any slug — there is no path list to match against", async () => {
    for (const slug of ["a", "another-one", "with-123-digits"]) {
      const { html } = await renderDynamic(`/live/${slug}`);
      expect(html).toContain(`<p id="slug">${slug}</p>`);
    }
  });

  test("gives Astro.url the requested pathname", async () => {
    expect((await renderDynamic("/live/some-slug")).html).toContain(
      '<p id="path">/live/some-slug</p>',
    );
  });
});

describe("renderPage, a dynamic route that resolves to nothing", () => {
  test("stays a 404 rather than rendering with the URL's params", async () => {
    const error = await rejection(renderDynamic("/mystery/anything"));
    expect(error).toBeInstanceOf(RoutePathNotFoundError);
    expect(error).toMatchObject({ reason: "not-enumerable" });
    expect(String(error)).toContain("nothing says what its paths are");
  });

  test("a markdown route cannot declare paths at all", async () => {
    const files = new Map([["src/pages/notes/[slug].md", "---\ntitle: N\n---\n\ntext\n"]]);
    const error = await rejection(renderPage({ files, pathname: "/notes/a", loader, compiler }));
    expect(error).toBeInstanceOf(RoutePathNotFoundError);
    expect(error).toMatchObject({ reason: "not-enumerable" });
  });
});

describe("projectPaths", () => {
  test("enumerates the static routes and every param set getStaticPaths returned", async () => {
    const paths = await projectPaths({ files: DYNAMIC, loader, compiler });
    // Trailing slashes because that is the URL `pletivo build` renders the file at,
    // and the URL paginate writes into `page.url`.
    expect(paths.map((path) => path.pathname).sort()).toEqual([
      "/",
      "/entry/one/",
      "/list/",
      "/list/2/",
      "/posts/hello/",
      "/posts/world/",
      "/tag/css/",
    ]);
  });

  test("carries the params, and only the params", async () => {
    const paths = await projectPaths({ files: DYNAMIC, loader, compiler });
    const post = paths.find((path) => path.pathname === "/posts/world/");
    expect(post).toEqual({
      file: "src/pages/posts/[slug].astro",
      pathname: "/posts/world/",
      params: { slug: "world" },
    });
  });

  test("keeps a rest param that matched nothing, which JSON would have dropped", async () => {
    // `{ page: undefined }` is how paginate names its first page. Serialized as an
    // object the key vanishes and the wrong entry matches.
    const paths = await projectPaths({ files: DYNAMIC, loader, compiler });
    const first = paths.find((path) => path.pathname === "/list/");
    expect(first?.params).toEqual({ page: undefined });
    expect(Object.keys(first?.params ?? {})).toEqual(["page"]);
  });

  test("lists nothing for a route with no path list", async () => {
    // `prerender = false` has none by design, and `mystery/[slug]` has none at all.
    const paths = await projectPaths({ files: DYNAMIC, loader, compiler });
    expect(paths.some((path) => path.pathname.startsWith("/live/"))).toBe(false);
    expect(paths.some((path) => path.pathname.startsWith("/mystery/"))).toBe(false);
  });

  test("every pathname it returns renders", async () => {
    for (const { pathname } of await projectPaths({ files: DYNAMIC, loader, compiler })) {
      expect((await renderDynamic(pathname)).html).toContain("<html>");
    }
  });

  test("starts no isolate for a project with no dynamic route", async () => {
    const quiet = new FileLoader();
    const paths = await projectPaths({
      files: new Map([["src/pages/index.astro", "<html><body>hi</body></html>\n"]]),
      loader: quiet,
      compiler,
    });
    expect(paths.map((path) => path.pathname)).toEqual(["/"]);
    expect(quiet.bundles.size).toBe(0);
    await quiet.cleanup();
  });
});

describe("isolate reuse across route kinds", () => {
  const at = (pathname: string, loaderFor: FileLoader) =>
    renderPage({ files: DYNAMIC, pathname, loader: loaderFor, compiler });

  test("every pathname of one route shares an isolate — params travel in the request", async () => {
    // What the module map may not hold: anything per request. The route and its params
    // ride in the request body, so two slugs of one route are one program — and if a
    // per-request value ever leaked into the map, these counts would climb.
    const reused = new FileLoader();
    const posts = [
      (await at("/posts/hello", reused)).bundleId,
      (await at("/posts/world", reused)).bundleId,
    ];
    const list = [
      (await at("/list", reused)).bundleId,
      (await at("/list/2", reused)).bundleId,
    ];
    expect(new Set(posts).size).toBe(1);
    expect(new Set(list).size).toBe(1);
    // One isolate per distinct module set: the two routes above, and nothing else.
    expect(reused.bundles.size).toBe(2);
    await reused.cleanup();
  });

  test("a page whose graph differs gets an isolate of its own, enumeration included", async () => {
    // The fragmentation the pruned compile buys the cheap render with. Enumeration
    // compiles every dynamic route at once, so it is a module set no single page has.
    const reused = new FileLoader();
    await projectPaths({ files: DYNAMIC, loader: reused, compiler });
    const ids = [
      (await at("/", reused)).bundleId,
      (await at("/posts/hello", reused)).bundleId,
      (await at("/live/anything", reused)).bundleId,
    ];
    expect(new Set(ids).size).toBe(3);
    expect(reused.bundles.size).toBe(4);
    await reused.cleanup();
  });
});

describe("renderPage, the page's stylesheet", () => {
  // A page importing CSS from its frontmatter, a `.js` module importing more of it,
  // and a second page reaching a stylesheet of its own — out of `src/`, because that
  // is the half the page's own graph decides. See `project-css.ts`.
  const styled = new Map<string, string>([
    [
      "src/pages/index.astro",
      '---\nimport "../styles/page.css";\nimport "../../vendor/index.css";\n' +
        'import { N } from "../lib/util.js";\n---\n' +
        "<html><head><title>{N}</title></head><body><p>hi</p></body></html>\n",
    ],
    ["src/lib/util.js", 'import "../../vendor/util.css";\nexport const N = "n";\n'],
    ["src/styles/page.css", ".page { color: red }\n"],
    ["src/styles/util.css", ".util { color: blue }\n"],
    ["vendor/index.css", ".from-index {}\n"],
    ["vendor/util.css", ".from-util {}\n"],
    ["vendor/bare.css", ".from-bare {}\n"],
    ["src/pages/bare.astro", '---\nimport "../../vendor/bare.css";\n---\n<html><body><p>bare</p></body></html>\n'],
    ["src/pages/nohead.astro", "<p>no head at all</p>\n"],
    ["src/pages/note.md", "---\ntitle: Note\n---\n\ntext\n"],
  ]);
  const renderStyled = (pathname: string) => renderPage({ files: styled, pathname, loader, compiler });

  /** The `<style>` blocks of a finished page, in document order. */
  function styleBlocks(html: string): string[] {
    return [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((match) => match[1]);
  }

  test("inlines the CSS in the head and hands back no asset for it", async () => {
    const page = await renderStyled("/");
    expect(page.assets).toEqual([]);
    expect(page.html).not.toContain('<link rel="stylesheet"');
    const [css] = styleBlocks(page.html);
    // Every source stylesheet, labelled and sorted — no import walk needed for these,
    // the glob over src/ already has them — then what the page's graph reached.
    expect(css).toStartWith(
      "/* styles/page.css */\n.page { color: red }\n\n\n/* styles/util.css */\n.util { color: blue }\n",
    );
    expect(css).toContain("/* vendor/index.css */");
  });

  test("holds only what the page's own graph reaches", async () => {
    const [index, bare] = await Promise.all([renderStyled("/"), renderStyled("/bare")]);

    // Reached transitively through the `.js` module, and never from the other page.
    expect(index.html).toContain(".from-util");
    expect(index.html).not.toContain(".from-bare");
    expect(bare.html).toContain(".from-bare");
    expect(bare.html).not.toContain(".from-index");
    // The source tree is the half that stays project-wide, on purpose: a stylesheet
    // nothing imports has no graph to be found through.
    expect(bare.html).toContain("/* styles/page.css */");
  });

  test("puts the page's sheet before its own <style>, so a scoped rule still wins", async () => {
    const files = new Map(styled);
    files.set(
      "src/pages/index.astro",
      '---\nimport "../styles/page.css";\n---\n' +
        "<html><head><title>t</title></head><body><p>hi</p></body></html>\n" +
        "<style>p { color: green }</style>\n",
    );
    const { html } = await renderPage({ files, pathname: "/", loader, compiler });
    const blocks = styleBlocks(html);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain("/* styles/page.css */");
    expect(blocks[1]).toContain("color:green");
  });

  test("gives a page with no </head> its CSS too, which the <link> never had", async () => {
    // The old model inserted the `<link>` only before `</head>` and had no fallback, so
    // such a page got its scoped rules and no stylesheet at all. One insertion fixes it.
    const page = await renderStyled("/nohead");
    expect(page.html).toStartWith("<style>/* styles/page.css */");
    expect(page.html).toEndWith("</style>\n<p>no head at all</p>");
  });

  test("inlines the source tree into a .md page without compiling the project", async () => {
    let transforms = 0;
    const counting: AstroCompiler = {
      transform: (source, transformOptions) => {
        transforms++;
        return compiler.transform(source, transformOptions);
      },
      parse: (source, parseOptions) => compiler.parse(source, parseOptions),
    };
    const page = await renderPage({ files: styled, pathname: "/note", loader, compiler: counting });

    // The whole reason the wasm compiler used to run for a markdown page was the
    // project-wide stylesheet. There is none now, and a `.md` page has no graph.
    expect(transforms).toBe(0);
    expect(page.bundleId).toBe("");
    expect(page.assets).toEqual([]);
    expect(page.html).toContain("<style>/* styles/page.css */");
    expect(page.html).not.toContain(".from-index");
  });

  test("produces no asset and no <style> for a project with no CSS", async () => {
    const page = await render("/plain");
    expect(page.assets).toEqual([]);
    expect(page.html).not.toContain('<link rel="stylesheet"');
    expect(page.html).not.toContain("<style>");
  });
});

describe("renderPage, Vite's import suffixes", () => {
  // The two the Bun host answers: `?raw`/`?inline` for the text, `?url` for the URL
  // of an emitted file. A real site reaches for both — see docs/todos/022.
  const queried = new Map<string, string>([
    [
      "src/pages/index.astro",
      "---\n" +
        'import icon from "../assets/mark.svg?raw";\n' +
        'import inlined from "../assets/mark.svg?inline";\n' +
        'import formUrl from "../scripts/form.js?url";\n' +
        "---\n" +
        "<html><head><title>t</title></head><body>\n" +
        "<div set:html={icon} />\n" +
        "<p>{inlined.length}</p>\n" +
        "<script src={formUrl}></script>\n" +
        "</body></html>\n",
    ],
    ["src/assets/mark.svg", '<svg viewBox="0 0 1 1"><title>mark</title></svg>'],
    ["src/scripts/form.js", "console.log('form');\n"],
  ]);
  const renderQueried = () => renderPage({ files: queried, pathname: "/", loader, compiler });

  test("?raw and ?inline both give the file's text", async () => {
    const { html } = await renderQueried();
    expect(html).toContain('<svg viewBox="0 0 1 1"><title>mark</title></svg>');
    expect(html).toContain("<p>48</p>");
  });

  test("?url gives a content-hashed href, and the file to serve it from", async () => {
    const page = await renderQueried();
    const asset = page.assets.find((candidate) => candidate.path.endsWith(".js"));
    expect(asset?.path).toMatch(/^\/_astro\/form\.[0-9a-f]{8}\.js$/);
    expect(asset?.contentType).toBe("text/javascript; charset=utf-8");
    expect(asset?.body).toBe("console.log('form');\n");
    expect(page.html).toContain(`<script src="${asset?.path}">`);
  });

  test("the ?url href is the file's content hash, so it survives a rename of nothing", async () => {
    const first = await renderQueried();
    const moved = new Map(queried);
    moved.set("src/scripts/form.js", "console.log('changed');\n");
    const second = await renderPage({ files: moved, pathname: "/", loader, compiler });
    const hrefOf = (page: Awaited<ReturnType<typeof renderQueried>>) =>
      page.assets.find((candidate) => candidate.path.endsWith(".js"))?.path;
    expect(hrefOf(first)).not.toBe(hrefOf(second));
  });

  test("a suffix naming no file leaves the import alone rather than inventing one", async () => {
    const missing = new Map(queried);
    missing.set(
      "src/pages/index.astro",
      '---\nimport gone from "../assets/gone.svg?raw";\n---\n<html><body><p>{gone}</p></body></html>\n',
    );
    expect(renderPage({ files: missing, pathname: "/", loader, compiler })).rejects.toThrow();
  });
});

describe("renderPage, refusals", () => {
  test("reports an unmatched pathname", () => {
    expect(render("/nope")).rejects.toBeInstanceOf(RouteNotFoundError);
  });

  test("refuses a page kind it has no compiler for", () => {
    expect(render("/notes")).rejects.toThrow(/only \.astro, \.tsx and \.md pages render here/);
  });

  test("refuses an endpoint route, which is not a page at all", async () => {
    const files = new Map([
      ["src/pages/rss.xml.ts", "export function GET() { return new Response('x'); }\n"],
    ]);
    const error = await rejection(renderPage({ files, pathname: "/rss.xml", loader, compiler }));
    expect(error).toBeInstanceOf(UnsupportedRouteError);
    expect(String(error)).toContain("endpoint routes are not implemented");
  });

  test("404s a dynamic route that never said what its paths are", async () => {
    // `blog/[slug].astro` declares neither getStaticPaths nor the on-demand opt-out.
    const error = await rejection(render("/blog/hello"));
    expect(error).toBeInstanceOf(RoutePathNotFoundError);
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
