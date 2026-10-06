import { describe, test, expect, beforeAll } from "bun:test";
import path from "path";
import fsp from "node:fs/promises";
import os from "node:os";
import {
  initCollections,
  getCollection,
  getContentBaseDirs,
  getEntry,
  runWithBunContentRuntime,
} from "../../packages/pletivo/src/content/collection";

const fixtureRoot = path.join(import.meta.dir, "../fixture");

describe("content collections", () => {
  beforeAll(async () => {
    await runWithBunContentRuntime(() => initCollections(fixtureRoot));
  });

  test("getCollection returns all entries", async () => {
    const posts = await runWithBunContentRuntime(() => getCollection("blog"));
    expect(posts.length).toBe(2);
  });

  test("getContentBaseDirs returns each collection's resolved base dir", () => {
    // Drives the dev server's watching of content that lives outside `src/`.
    const dirs = runWithBunContentRuntime(() => getContentBaseDirs(fixtureRoot));
    expect(dirs).toContain(path.join(fixtureRoot, "src/content/blog"));
    expect(dirs).toContain(path.join(fixtureRoot, "src/content/news"));
  });

  test("entries have correct structure", async () => {
    const posts = await runWithBunContentRuntime(() => getCollection("blog"));
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
    const posts = await runWithBunContentRuntime(() => getCollection("blog"));
    const ids = posts.map((p) => p.id).sort();
    expect(ids).toEqual(["post-one", "post-two"]);
  });

  test("frontmatter data is validated and parsed", async () => {
    const post = await runWithBunContentRuntime(() => getEntry("blog", "post-one"));
    expect(post).toBeDefined();
    expect(post!.data.title).toBe("First Post");
    expect(post!.data.tags).toEqual(["intro"]);
  });

  test("draft field has default value", async () => {
    const post = await runWithBunContentRuntime(() => getEntry("blog", "post-one"));
    expect(post!.data.draft).toBe(false);
  });

  test("draft field is parsed when present", async () => {
    const post = await runWithBunContentRuntime(() => getEntry("blog", "post-two"));
    expect(post!.data.draft).toBe(true);
  });

  test("render() returns HTML from markdown body", async () => {
    const { html } = await runWithBunContentRuntime(async () => {
      const post = await getEntry("blog", "post-one");
      if (post === undefined) throw new Error("fixture entry post-one is missing");
      return post.render();
    });
    expect(html).toContain("First Post</h1>");
    expect(html).toContain("<strong>first</strong>");
  });

  test("getCollection with filter", async () => {
    const nonDraft = await runWithBunContentRuntime(() =>
      getCollection("blog", (entry) => !Reflect.get(entry.data, "draft")),
    );
    expect(nonDraft.length).toBe(1);
    expect(nonDraft[0].id).toBe("post-one");
  });

  test("getEntry returns undefined for nonexistent", async () => {
    const post = await runWithBunContentRuntime(() => getEntry("blog", "nonexistent"));
    expect(post).toBeUndefined();
  });

  test("nonexistent collection throws", async () => {
    expect(runWithBunContentRuntime(() => getCollection("nonexistent"))).rejects.toThrow(
      'Collection "nonexistent" not found',
    );
  });

  test("subdirectory-nested entries keep the path prefix in their ID", async () => {
    // Astro parity + i18n dir-per-locale use case: a file at
    // `src/content/news/cs/praha-2.md` must produce `id: "cs/praha-2"`,
    // not `cs-praha-2`. Users rely on the prefix for
    // `entry.id.startsWith("cs/")` filters in multilingual sites.
    const news = await runWithBunContentRuntime(() => getCollection("news"));
    const ids = news.map((e) => e.id).sort();
    expect(ids).toEqual(["cs/brno-1", "cs/praha-2", "en/prague-2"]);
  });

  test("getCollection filter by locale prefix works", async () => {
    const cs = await runWithBunContentRuntime(() =>
      getCollection("news", (entry) => entry.id.startsWith("cs/")),
    );
    expect(cs.length).toBe(2);
    const csIds = cs.map((e) => e.id).sort();
    expect(csIds).toEqual(["cs/brno-1", "cs/praha-2"]);
  });

  test("getEntry resolves a nested ID", async () => {
    const entry = await runWithBunContentRuntime(() => getEntry("news", "cs/praha-2"));
    expect(entry).toBeDefined();
    expect(entry!.data.title).toBe("Praha 2");
  });
});

describe("content roots outside src/", () => {
  test("getContentBaseDirs surfaces a project-root content dir (the CMS-write case the dev watcher must cover)", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "pletivo-roots-"));
    const collectionModule = path.join(import.meta.dir, "../../packages/pletivo/src/content/collection");
    try {
      await fsp.mkdir(path.join(root, "src"), { recursive: true });
      await fsp.mkdir(path.join(root, "content/posts"), { recursive: true });
      await fsp.writeFile(
        path.join(root, "src/content.config.ts"),
        `import { defineCollection, glob } from ${JSON.stringify(collectionModule)};\n`
          + `export const collections = { posts: defineCollection({ loader: glob({ base: "content/posts" }) }) };\n`,
      );

      await runWithBunContentRuntime(() => initCollections(root));
      const dirs = runWithBunContentRuntime(() => getContentBaseDirs(root));

      // The base lives at project-root content/, NOT under src/ — so the dev server's
      // srcDir watcher can't see writes there and must add a dedicated watcher.
      expect(dirs).toContain(path.join(root, "content", "posts"));
      expect(path.relative(root, path.join(root, "content", "posts")).startsWith("src")).toBe(false);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
