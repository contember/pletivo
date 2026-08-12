import { afterAll, describe, expect, test } from "bun:test";
import { createAstroCompiler } from "../src/astro-compiler.ts";
import { compileProject, isContentApi } from "../src/compile-project.ts";
import { ContentFiles, globMatcher } from "../src/content-files.ts";
import { CONTENT_MODULE_NAME } from "../src/generated/runtime-modules.ts";
import { ContentUnavailableError, projectPaths, renderPage } from "../src/render.ts";
import { astroWasmModule } from "./astro-wasm.ts";
import { FileLoader } from "./file-loader.ts";

/**
 * Content collections on the Workers host.
 *
 * `test/fixture-parity.test.ts` is where the bytes are compared against
 * `pletivo build`. What is here is the part parity cannot show: that content stays
 * out of the module map, and what that costs.
 */

const compiler = createAstroCompiler(await astroWasmModule());
const loader = new FileLoader();
afterAll(() => loader.cleanup());

const CONFIG = `import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

export const collections = {
  notes: defineCollection({
    // \`./\` on purpose: \`path.resolve\` drops it on the Bun host, and a scan that
    // joined it verbatim would look under a prefix no file-map key starts with —
    // an empty collection and a page that renders fine and is wrong.
    loader: glob({ base: "./src/content/notes" }),
    schema: z.object({ title: z.string() }),
  }),
};
`;

const INDEX = `---
import { getCollection } from "astro:content";
const notes = await getCollection("notes");
---
<html><body><ul>{notes.map((note) => <li>{note.data.title}</li>)}</ul></body></html>
`;

/** A minimal project with one collection, so a test can edit its content in place. */
function project(notes: Record<string, string>): Map<string, string> {
  const files = new Map<string, string>([
    ["src/content.config.ts", CONFIG],
    ["src/pages/index.astro", INDEX],
  ]);
  for (const [name, source] of Object.entries(notes)) {
    files.set(`src/content/notes/${name}`, source);
  }
  return files;
}

function note(title: string, body = "body"): string {
  return `---\ntitle: ${title}\n---\n\n${body}\n`;
}

function contentAccess(): { binding: ContentFiles; store: ContentFiles } {
  // On Bun the binding and the store are the same object; in workerd the binding is
  // a loopback stub and the store lives in the host worker.
  const files = new ContentFiles();
  return { binding: files, store: files };
}

async function render(files: Map<string, string>, content = contentAccess()) {
  return renderPage({ files, pathname: "/", loader, compiler, content });
}

describe("content collections", () => {
  test("render a collection into a page", async () => {
    const page = await render(project({ "a.md": note("Alpha"), "b.md": note("Beta") }));
    expect(page.html).toContain("<li>Alpha</li><li>Beta</li>");
  });

  test("enumerate in scan order, not in file-map order", async () => {
    // The file map is built in insertion order; the scan has to sort regardless, or
    // the same sources render differently depending on how they were collected.
    const files = new Map<string, string>([
      ["src/content.config.ts", CONFIG],
      ["src/pages/index.astro", INDEX],
      ["src/content/notes/zulu.md", note("Zulu")],
      ["src/content/notes/alpha.md", note("Alpha")],
      ["src/content/notes/nested/mike.md", note("Mike")],
    ]);
    const page = await render(files);
    expect(page.html).toContain("<li>Alpha</li><li>Mike</li><li>Zulu</li>");
  });

  test("keep content out of the module map, so an edit reuses the isolate", async () => {
    // The whole reason the isolate reads files over a binding. If the markdown were a
    // module, editing one word would mint a new dynamic Worker — on every keystroke
    // of the exact workflow this package exists for.
    const before = await render(project({ "a.md": note("Before") }));
    const after = await render(project({ "a.md": note("After") }));

    expect(after.bundleId).toBe(before.bundleId);
    expect(before.html).toContain("<li>Before</li>");
    expect(after.html).toContain("<li>After</li>");
  });

  test("drop the collection store between renders", async () => {
    // The failure the design above invites: the isolate outlives the request, so a
    // module-global store would answer the second render with the first one's
    // entries — and the bundle id being identical is exactly why nothing else would
    // catch it. `initCollections` runs per request for this reason.
    const content = contentAccess();
    const first = await render(project({ "a.md": note("First") }), content);
    const second = await render(project({ "a.md": note("Second") }), content);

    expect(second.bundleId).toBe(first.bundleId);
    expect(second.html).toContain("<li>Second</li>");
    expect(second.html).not.toContain("First");
  });

  test("see a file that appeared since the last render", async () => {
    const content = contentAccess();
    const first = await render(project({ "a.md": note("Alpha") }), content);
    const second = await render(
      project({ "a.md": note("Alpha"), "b.md": note("Beta") }),
      content,
    );
    expect(first.html).not.toContain("Beta");
    expect(second.html).toContain("<li>Alpha</li><li>Beta</li>");
    expect(second.bundleId).toBe(first.bundleId);
  });

  test("keep two concurrent renders of different sources apart", async () => {
    // Why every binding call carries a ref rather than reading a "current project".
    // Measured in workerd: with a mutable module global, the slower of two overlapping
    // requests read the faster one's content.
    const content = contentAccess();
    const [left, right] = await Promise.all([
      render(project({ "a.md": note("Left") }), content),
      render(project({ "a.md": note("Right") }), content),
    ]);
    expect(left.html).toContain("<li>Left</li>");
    expect(right.html).toContain("<li>Right</li>");
  });

  test("close every handle the renders opened", async () => {
    const content = contentAccess();
    await render(project({ "a.md": note("Alpha") }), content);
    expect(content.store.openCount).toBe(0);
  });

  test("close the handle even when the render throws", async () => {
    const content = contentAccess();
    const files = project({ "a.md": "---\nnotitle: true\n---\n" });
    files.set("src/pages/index.astro", `---\nthrow new Error("boom");\n---\n<html></html>\n`);
    await expect(render(files, content)).rejects.toThrow();
    expect(content.store.openCount).toBe(0);
  });

  test("resolve a collection through getStaticPaths, out here as well", async () => {
    const files = project({ "a.md": note("Alpha"), "b.md": note("Beta") });
    files.set(
      "src/pages/notes/[slug].astro",
      `---
import { getCollection } from "astro:content";
export async function getStaticPaths() {
  const notes = await getCollection("notes");
  return notes.map((note) => ({ params: { slug: note.id }, props: { note } }));
}
const { note } = Astro.props;
---
<html><body><h1>{note.data.title}</h1></body></html>
`,
    );
    const paths = await projectPaths({ files, loader, compiler, content: contentAccess() });
    expect(paths.map((path) => path.pathname).sort()).toEqual(["/", "/notes/a/", "/notes/b/"]);
  });

  test("refuse to render a content project with nothing to read content with", async () => {
    // Rendering it anyway would give an empty collection and a page that looks fine.
    await expect(
      renderPage({ files: project({ "a.md": note("Alpha") }), pathname: "/", loader, compiler }),
    ).rejects.toThrow(ContentUnavailableError);
  });
});

describe("the content module in the bundle", () => {
  /**
   * Pruned to the page, which is what makes these tests about the *seed*.
   *
   * Nothing in a project imports `src/content.config.ts` — the isolate's prelude reaches
   * it through a thunk — so under a walk from the page it is only in the bundle because
   * `compileProject` puts it there on seeing the content API. Compiled whole, it would
   * be there whether that worked or not.
   */
  const ENTRIES = ["src/pages/index.astro"];

  test("is added only when a project reaches for the API", async () => {
    const bare = await compileProject({
      files: new Map([["src/pages/index.astro", "<html><body>hi</body></html>\n"]]),
      entries: ENTRIES,
      compiler,
    });
    expect(bare.content).toBeNull();
    expect(bare.modules[CONTENT_MODULE_NAME]).toBeUndefined();

    const withContent = await compileProject({
      files: project({ "a.md": note("Alpha") }),
      entries: ENTRIES,
      compiler,
    });
    expect(withContent.content).not.toBeNull();
    expect(withContent.modules[CONTENT_MODULE_NAME]).toBeString();
  });

  test("names the config module for the isolate to execute", async () => {
    const compiled = await compileProject({
      files: project({ "a.md": note("Alpha") }),
      entries: ENTRIES,
      compiler,
    });
    const configModule = compiled.content?.configModule;
    expect(configModule).toBe(compiled.moduleNames.get("src/content.config.ts"));
    // The isolate imports it behind a thunk, so a throw at its module scope fails the
    // render rather than the isolate.
    expect(compiled.modules[configModule ?? ""]).toContain("defineCollection");
  });

  test("finds the config under the srcDir the caller named", async () => {
    // Eight `has()` probes instead of a scan of every key, which is what a lazy file
    // store needs. The suffix scan stays for a caller that names no srcDir.
    const files = new Map<string, string>();
    for (const [file, source] of project({ "a.md": note("Alpha") })) files.set(`site/${file}`, source);
    const compiled = await compileProject({
      files,
      entries: ["site/src/pages/index.astro"],
      srcDir: "site/src",
      compiler,
    });
    expect(compiled.content?.configModule).toBe(compiled.moduleNames.get("site/src/content.config.ts"));
  });

  test("is reached from a page and from the config through one specifier", async () => {
    const compiled = await compileProject({
      files: project({ "a.md": note("Alpha") }),
      entries: ENTRIES,
      compiler,
    });
    const config = compiled.modules[compiled.moduleNames.get("src/content.config.ts") ?? ""];
    const page = compiled.modules[compiled.moduleNames.get("src/pages/index.astro") ?? ""];
    // Two compilers (`@astrojs/compiler` and sucrase) and two specifiers
    // (`astro:content`, `astro/loaders`), one module — otherwise `initCollections`
    // would fill a store the page never reads.
    expect(config).toContain(`"./${CONTENT_MODULE_NAME}"`);
    expect(page).toContain(`"./${CONTENT_MODULE_NAME}"`);
  });

  test("recognises the shapes a project reaches the API by", () => {
    for (const specifier of ["astro:content", "astro/loaders", "pletivo/content"]) {
      expect([specifier, isContentApi(specifier)]).toEqual([specifier, true]);
    }
    // This repo's own fixtures reach in by relative path; `resolveSpecifier` lands
    // every one of them on this key, whatever depth the importer sits at.
    expect(isContentApi("packages/pletivo/src/content/collection")).toBe(true);
    expect(isContentApi("node_modules/pletivo/src/content/index.ts")).toBe(true);

    expect(isContentApi("src/content/collection.ts")).toBe(false);
    expect(isContentApi("astro:assets")).toBe(false);
    expect(isContentApi("./content.ts")).toBe(false);
  });
});

describe("ContentFiles", () => {
  const files = new Map([
    ["site/src/content/posts/a.md", "a"],
    ["site/src/content/posts/nested/b.md", "b"],
    ["site/src/content/posts/c.txt", "c"],
    ["site/src/content/posts/.hidden.md", "h"],
    ["site/src/pages/index.astro", "page"],
  ]);

  test("scan only the directory asked for, sorted", () => {
    const store = new ContentFiles();
    const { ref } = store.open(files);
    expect(store.scan(ref, "site/src/content/posts", "**/*.{md,mdx}")).toEqual([
      { entry: "a.md", path: "site/src/content/posts/a.md" },
      { entry: "nested/b.md", path: "site/src/content/posts/nested/b.md" },
    ]);
  });

  test("read a file by the path a scan reported, and only while it is open", () => {
    const store = new ContentFiles();
    const handle = store.open(files);
    expect(store.read(handle.ref, "site/src/content/posts/a.md")).toBe("a");
    expect(store.read(handle.ref, "site/src/content/posts/missing.md")).toBeNull();
    handle.close();
    expect(() => store.read(handle.ref, "site/src/content/posts/a.md")).toThrow(/no open project/);
  });

  test("keep two open projects apart", () => {
    const store = new ContentFiles();
    const left = store.open(new Map([["x.md", "left"]]));
    const right = store.open(new Map([["x.md", "right"]]));
    expect(store.read(left.ref, "x.md")).toBe("left");
    expect(store.read(right.ref, "x.md")).toBe("right");
    expect(store.openCount).toBe(2);
    left.close();
    right.close();
    expect(store.openCount).toBe(0);
  });
});

describe("globMatcher", () => {
  test("matches the default content pattern at any depth, including none", () => {
    const match = globMatcher("**/*.{md,mdx}");
    expect(match("post.md")).toBe(true);
    expect(match("post.mdx")).toBe(true);
    expect(match("a/b/post.md")).toBe(true);
    expect(match("post.txt")).toBe(false);
  });

  test("keeps `*` inside one segment", () => {
    const match = globMatcher("*.json");
    expect(match("a.json")).toBe(true);
    expect(match("nested/a.json")).toBe(false);
  });

  test("skips dotfiles, as Bun.Glob.scan does by default", () => {
    // Otherwise an editor's `.backup.md` would be a collection entry on one host and
    // not on the other.
    const match = globMatcher("**/*.md");
    expect(match(".backup.md")).toBe(false);
    expect(match(".git/x.md")).toBe(false);
  });

  test("treats a regex metacharacter as a literal", () => {
    const match = globMatcher("**/*.md");
    expect(match("a+b.md")).toBe(true);
    expect(globMatcher("v1.0/*.md")("v1x0/a.md")).toBe(false);
  });
});
