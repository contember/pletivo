import { describe, test, expect, beforeAll, beforeEach, spyOn } from "bun:test";
import path from "path";
import {
  initCollections,
  getCollection,
  getEntry,
  getEntryBySlug,
  getDataEntryById,
  runWithBunContentRuntime,
  type Reference,
} from "../../packages/pletivo/src/content/collection";
import { registerMdxPlugin } from "../../packages/pletivo/src/mdx-plugin";
import { jsx } from "../../packages/pletivo/src/runtime/jsx-runtime";
import { isNativeComponent } from "@pletivo/runtime/astro-islands/native";

const fixtureRoot = path.join(import.meta.dir, "../fixture-legacy-collections");

/** The messages `console.warn` received while `fn` ran. */
async function warningsOf(fn: () => Promise<unknown>): Promise<string[]> {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await fn();
    return warn.mock.calls.map((args) => args.map(String).join(" "));
  } finally {
    warn.mockRestore();
  }
}

describe("collections defined without a loader (Astro 5 legacy collections)", () => {
  beforeAll(async () => {
    await registerMdxPlugin();
  });

  // A fresh generation per test, so a collection's load (and its warnings) belongs to the test.
  beforeEach(async () => {
    // The orphan/ folder's auto-generation warning is asserted in its own test.
    await warningsOf(() => runWithBunContentRuntime(() => initCollections(fixtureRoot)));
  });

  test("a content collection reads src/content/<name>/, skipping _-prefixed paths and data files", async () => {
    const entries = await runWithBunContentRuntime(() => getCollection("docs"));
    expect(entries.map((e) => ({ id: e.id, slug: e.slug }))).toEqual([
      { id: "Guides/Getting Started.md", slug: "guides/getting-started" },
      { id: "Guides/index.md", slug: "guides" },
      { id: "callout.mdx", slug: "callout" },
      { id: "custom.md", slug: "renamed" },
      { id: "intro.md", slug: "intro" },
      { id: "notes.mdoc", slug: "notes" },
      { id: "other.markdown", slug: "other" },
      { id: "page.mdx", slug: "page" },
    ]);
  });

  test("getEntry finds a content entry by its slug, as Astro does", async () => {
    const intro = await runWithBunContentRuntime(() => getEntry("docs", "intro"));
    expect(intro?.data.title).toBe("Intro");
    const byFrontmatterSlug = await runWithBunContentRuntime(() => getEntry("docs", "renamed"));
    expect(byFrontmatterSlug?.id).toBe("custom.md");
    expect(await runWithBunContentRuntime(() => getEntry("docs", "intro.md"))).toBeUndefined();
  });

  test("the deprecated getEntryBySlug and getDataEntryById find an entry by slug and by id", async () => {
    expect((await runWithBunContentRuntime(() => getEntryBySlug("docs", "renamed")))?.id).toBe("custom.md");
    expect(await runWithBunContentRuntime(() => getEntryBySlug("docs", "custom.md"))).toBeUndefined();
    expect((await runWithBunContentRuntime(() => getDataEntryById("authors", "jane")))?.data).toBeDefined();
    expect(await runWithBunContentRuntime(() => getDataEntryById("authors", "nobody"))).toBeUndefined();
  });

  test("getEntry takes a { collection, slug } lookup", async () => {
    const entry = await runWithBunContentRuntime(() => getEntry({ collection: "docs", slug: "renamed" }));
    expect(entry?.id).toBe("custom.md");
  });

  test("reference() accepts { slug, collection }, and getEntry resolves it", async () => {
    const [refs] = await runWithBunContentRuntime(() => getCollection<{ doc: Reference }>("refs"));
    expect(refs?.data.doc.slug).toBe("renamed");
    const doc = await runWithBunContentRuntime(() => getEntry(refs?.data.doc));
    expect(doc?.id).toBe("custom.md");
  });

  test("the frontmatter slug is not part of data, so a strict schema accepts it", async () => {
    const custom = await runWithBunContentRuntime(() => getEntry("docs", "renamed"));
    expect(custom?.data).toEqual({ title: "Custom" });
    const strict = await runWithBunContentRuntime(() => getCollection("strict"));
    expect(strict.map((e) => ({ slug: e.slug, data: e.data }))).toEqual([
      { slug: "strictly", data: { title: "Strict" } },
    ]);
  });

  test("an entry of a collection without a schema keeps its frontmatter and renders", async () => {
    const intro = await runWithBunContentRuntime(() => getEntry("docs", "intro"));
    expect(intro?.data).toEqual({ title: "Intro" });
    const rendered = await intro?.render();
    expect(rendered?.html).toContain("Welcome</h1>");
  });

  test("render() also returns Astro's Content, headings and remarkPluginFrontmatter", async () => {
    const intro = await runWithBunContentRuntime(() => getEntry("docs", "intro"));
    const rendered = await intro?.render();
    expect(rendered?.headings).toEqual([]);
    expect(rendered?.remarkPluginFrontmatter).toEqual({});
    expect(isNativeComponent(rendered?.Content)).toBe(true);
    const content = await rendered?.Content?.();
    expect(content?.__html).toContain("Welcome</h1>");
  });

  test("a non-.md Markdown spelling is a content entry", async () => {
    const other = await runWithBunContentRuntime(() => getEntry("docs", "other"));
    expect(other?.id).toBe("other.markdown");
    expect((await other?.render())?.html).toContain("<code>.markdown</code>");
  });

  test("an .mdx entry renders through the MDX pipeline", async () => {
    const page = await runWithBunContentRuntime(() => getEntry("docs", "page"));
    expect(page?.data).toEqual({ title: "MDX page" });
    const rendered = await page?.render();
    expect(rendered?.html).toContain("From MDX</h1>");
    expect(rendered?.html).toContain("Two is 2.");
    const content = await rendered?.Content?.();
    expect(content?.__html).toContain("Two is 2.");
  });

  test("an .mdx entry's Content takes a component the body does not import", async () => {
    const Callout = (props: { children?: unknown }) => jsx("aside", { children: props.children });
    const entry = await runWithBunContentRuntime(() => getEntry("docs", "callout"));
    const rendered = await entry?.render();
    const content = await rendered?.Content?.({ components: { Callout } });
    expect(content?.__html).toContain("<aside>inside</aside>");
    // Without the component the body cannot render, and `html` says so.
    expect(() => rendered?.html).toThrow(/Callout/);
  });

  test("an .mdx entry's Content without components reuses render()'s output", async () => {
    let calls = 0;
    const Callout = (props: { children?: unknown }) => {
      calls++;
      return jsx("aside", { children: props.children });
    };
    const entry = await runWithBunContentRuntime(() => getEntry("docs", "callout"));
    const rendered = await entry?.render({ Callout });
    expect(rendered?.html).toContain("<aside>inside</aside>");
    const content = await rendered?.Content?.();
    expect(content?.__html).toBe(rendered?.html ?? "");
    expect(calls).toBe(1);
  });

  test("a Markdoc entry has its data, but rendering it fails by name", async () => {
    const notes = await runWithBunContentRuntime(() => getEntry("docs", "notes"));
    expect(notes?.data).toEqual({ title: "Notes" });
    await expect(notes?.render()).rejects.toThrow(
      /notes\.mdoc: pletivo has no Markdoc renderer for \.mdoc entries\. Rename it to \.md if it is plain Markdown/,
    );
  });

  test("a collection whose directory does not exist is empty and warns", async () => {
    let entries: unknown[] = [];
    const warnings = await warningsOf(async () => {
      entries = await runWithBunContentRuntime(() => getCollection("missing"));
    });
    expect(entries).toEqual([]);
    expect(warnings).toEqual([
      'No files found matching "**/*.{md,markdown,mdown,mkdn,mkd,mdwn,mdx,mdoc}" in directory ' +
        '"src/content/missing". Collection "missing" has no loader, so it is read from there.',
    ]);
  });

  test("a repeated slug warns and the later file replaces the earlier one", async () => {
    let entries: Array<{ id: string; slug?: string; data: Record<string, unknown> }> = [];
    const warnings = await warningsOf(async () => {
      entries = await runWithBunContentRuntime(() => getCollection("dup"));
    });
    expect(entries.map((e) => ({ id: e.id, slug: e.slug, title: e.data.title }))).toEqual([
      { id: "b.md", slug: "same", title: "Second" },
    ]);
    expect(warnings).toEqual([
      'Duplicate id "same" found in src/content/dup/b.md. Later items with the same id will overwrite earlier ones.',
    ]);
  });

  test("a data collection reads JSON and YAML, with ids that keep their path", async () => {
    const authors = await runWithBunContentRuntime(() => getCollection("authors"));
    expect(authors.map((e) => ({ id: e.id, slug: e.slug, name: e.data.name }))).toEqual([
      { id: "jane", slug: undefined, name: "Jane" },
      { id: "team/john", slug: undefined, name: "John" },
    ]);
  });
  test("an undefined src/content/ folder becomes a content collection, as Astro 5 auto-generates it", async () => {
    const warnings = await warningsOf(() => runWithBunContentRuntime(() => initCollections(fixtureRoot)));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("The following collections have been auto-generated: orphan");
    const entries = await runWithBunContentRuntime(() => getCollection("orphan"));
    expect(entries.map((e) => ({ id: e.id, slug: e.slug, title: e.data.title }))).toEqual([
      { id: "first.md", slug: "first", title: "Orphan" },
    ]);
    expect(runWithBunContentRuntime(() => getCollection("_hidden"))).rejects.toThrow('Collection "_hidden" not found');
  });
});
