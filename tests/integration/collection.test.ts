import { describe, test, expect, beforeAll } from "bun:test";
import path from "path";
import { initCollections, getCollection, getEntry } from "../../packages/pavouk/src/content/collection";

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
      expect(post.html).toBeTypeOf("string");
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

  test("HTML is rendered from markdown body", async () => {
    const post = await getEntry("blog", "post-one");
    expect(post!.html).toContain("<h1>First Post</h1>");
    expect(post!.html).toContain("<strong>first</strong>");
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
});
