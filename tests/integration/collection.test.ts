import { describe, test, expect, beforeAll } from "bun:test";
import path from "path";
import { initCollections, getCollection, getEntry } from "../../packages/pletivo/src/content/collection";

const fixtureRoot = path.join(import.meta.dir, "../fixture");

describe("content collections", () => {
  beforeAll(async () => {
    await initCollections(fixtureRoot);
  });

  test("getCollection returns all entries", async () => {
    const posts = await getCollection("blog");
    expect(posts.length).toBe(2);
  });

  test("entries have correct structure", async () => {
    const posts = await getCollection("blog");
    for (const post of posts) {
      expect(post.id).toBeTypeOf("string");
      expect(post.data).toBeTypeOf("object");
      expect(post.body).toBeTypeOf("string");
      expect(post.render).toBeTypeOf("function");
      expect(post.data.title).toBeTypeOf("string");
      expect(post.data.date).toBeInstanceOf(Date);
    }
  });

  test("entry IDs are derived from filenames", async () => {
    const posts = await getCollection("blog");
    const ids = posts.map((p) => p.id).sort();
    expect(ids).toEqual(["post-one", "post-two"]);
  });

  test("frontmatter data is validated and parsed", async () => {
    const post = await getEntry("blog", "post-one");
    expect(post).toBeDefined();
    expect(post!.data.title).toBe("First Post");
    expect(post!.data.tags).toEqual(["intro"]);
  });

  test("draft field has default value", async () => {
    const post = await getEntry("blog", "post-one");
    expect(post!.data.draft).toBe(false);
  });

  test("draft field is parsed when present", async () => {
    const post = await getEntry("blog", "post-two");
    expect(post!.data.draft).toBe(true);
  });

  test("render() returns HTML from markdown body", async () => {
    const post = await getEntry("blog", "post-one");
    const { html } = await post!.render();
    expect(html).toContain("First Post</h1>");
    expect(html).toContain("<strong>first</strong>");
  });

  test("getCollection with filter", async () => {
    const nonDraft = await getCollection("blog", (e) => !(e.data as any).draft);
    expect(nonDraft.length).toBe(1);
    expect(nonDraft[0].id).toBe("post-one");
  });

  test("getEntry returns undefined for nonexistent", async () => {
    const post = await getEntry("blog", "nonexistent");
    expect(post).toBeUndefined();
  });

  test("nonexistent collection throws", async () => {
    expect(getCollection("nonexistent")).rejects.toThrow('Collection "nonexistent" not found');
  });

  test("subdirectory-nested entries keep the path prefix in their ID", async () => {
    // Astro parity + i18n dir-per-locale use case: a file at
    // `src/content/news/cs/praha-2.md` must produce `id: "cs/praha-2"`,
    // not `cs-praha-2`. Users rely on the prefix for
    // `entry.id.startsWith("cs/")` filters in multilingual sites.
    const news = await getCollection("news");
    const ids = news.map((e) => e.id).sort();
    expect(ids).toEqual(["cs/brno-1", "cs/praha-2", "en/prague-2"]);
  });

  test("getCollection filter by locale prefix works", async () => {
    const cs = await getCollection("news", (e) => e.id.startsWith("cs/"));
    expect(cs.length).toBe(2);
    const csIds = cs.map((e) => e.id).sort();
    expect(csIds).toEqual(["cs/brno-1", "cs/praha-2"]);
  });

  test("getEntry resolves a nested ID", async () => {
    const entry = await getEntry("news", "cs/praha-2");
    expect(entry).toBeDefined();
    expect(entry!.data.title).toBe("Praha 2");
  });
});
