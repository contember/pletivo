import { describe, test, expect, beforeAll } from "bun:test";
import path from "path";
import {
  initCollections,
  getCollection,
  getEntry,
  runWithBunContentRuntime,
} from "../../packages/pletivo/src/content/collection";

const fixtureRoot = path.join(import.meta.dir, "../fixture-legacy-collections");

describe("collections defined without a loader (Astro 5 legacy collections)", () => {
  beforeAll(async () => {
    await runWithBunContentRuntime(() => initCollections(fixtureRoot));
  });

  test("a content collection reads src/content/<name>/, skipping _-prefixed paths and data files", async () => {
    const entries = await runWithBunContentRuntime(() => getCollection("docs"));
    expect(entries.map((e) => ({ id: e.id, slug: e.slug }))).toEqual([
      { id: "Guides/Getting Started.md", slug: "guides/getting-started" },
      { id: "Guides/index.md", slug: "guides" },
      { id: "custom.md", slug: "renamed" },
      { id: "intro.md", slug: "intro" },
    ]);
  });

  test("getEntry finds a content entry by its slug, as Astro does", async () => {
    const intro = await runWithBunContentRuntime(() => getEntry("docs", "intro"));
    expect(intro?.data.title).toBe("Intro");
    const byFrontmatterSlug = await runWithBunContentRuntime(() => getEntry("docs", "renamed"));
    expect(byFrontmatterSlug?.id).toBe("custom.md");
    expect(await runWithBunContentRuntime(() => getEntry("docs", "intro.md"))).toBeUndefined();
  });

  test("an entry of a collection without a schema keeps its frontmatter and renders", async () => {
    const intro = await runWithBunContentRuntime(() => getEntry("docs", "intro"));
    expect(intro?.data).toEqual({ title: "Intro" });
    const rendered = await intro?.render();
    expect(rendered?.html).toContain("Welcome</h1>");
  });

  test("a data collection reads JSON and YAML, with ids that keep their path", async () => {
    const authors = await runWithBunContentRuntime(() => getCollection("authors"));
    expect(authors.map((e) => ({ id: e.id, slug: e.slug, name: e.data.name }))).toEqual([
      { id: "jane", slug: undefined, name: "Jane" },
      { id: "team/john", slug: undefined, name: "John" },
    ]);
  });
});
