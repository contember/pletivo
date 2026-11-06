import { describe, expect, test } from "bun:test";
import {
  createContentRuntime,
  defineCollection,
  getCollection,
  glob,
  initCollections,
  runWithContentRuntime,
  type ContentHost,
  type FrontmatterCache,
  type ParsedFrontmatter,
  z,
} from "@pletivo/core/content/collection";

// Loose, so `tags` reaches the entry as parsed rather than as a copy the schema made.
const collections = { posts: defineCollection({ loader: glob({ base: "posts" }), schema: z.looseObject({ title: z.string() }) }) };

/** A host over `files` that builds a fresh runtime per load, as a Worker host does per request. */
function loadPosts(files: ReadonlyMap<string, string>, cache: FrontmatterCache): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
  const host: ContentHost = {
    async scan(_projectRoot, base) {
      const entries = [...files.keys()].filter((path) => path.startsWith(`${base}/`)).sort();
      return {
        root: base,
        rootUrl: new URL(`file:///${base}/`),
        files: entries.map((path) => ({ entry: path.slice(base.length + 1), path })),
      };
    },
    async readFile(path) {
      const text = files.get(path);
      if (text === undefined) throw new Error(`no file ${path}`);
      return text;
    },
    dirname: (path) => path.slice(0, path.lastIndexOf("/")),
    resolveDir: (_root, base) => base,
    loadConfig: async () => collections,
    frontmatterCache: cache,
  };
  const runtime = createContentRuntime(host);
  return runWithContentRuntime(runtime, async () => {
    await initCollections("");
    return getCollection("posts");
  });
}

class CountingCache implements FrontmatterCache {
  readonly parses = new Map<string, ParsedFrontmatter>();
  sets = 0;
  get(text: string): ParsedFrontmatter | undefined {
    return this.parses.get(text);
  }
  set(text: string, parsed: ParsedFrontmatter): void {
    this.sets++;
    this.parses.set(text, parsed);
  }
}

describe("ContentHost.frontmatterCache", () => {
  test("a later runtime parses again only the files whose text changed", async () => {
    const files = new Map([
      ["posts/a.md", "---\ntitle: A\n---\nBody A\n"],
      ["posts/b.md", "---\ntitle: B\n---\nBody B\n"],
    ]);
    const cache = new CountingCache();
    await loadPosts(files, cache);
    expect(cache.sets).toBe(2);

    files.set("posts/b.md", "---\ntitle: B2\n---\nBody B\n");
    const entries = await loadPosts(files, cache);

    expect(cache.sets).toBe(3);
    expect(entries.map((entry) => entry.data.title)).toEqual(["A", "B2"]);
  });

  test("a change one render makes to an entry's data does not reach the next", async () => {
    const files = new Map([["posts/a.md", "---\ntitle: A\ntags: [one]\n---\nBody\n"]]);
    const cache = new CountingCache();
    const [first] = await loadPosts(files, cache);
    const tags = first?.data.tags;
    if (!Array.isArray(tags)) throw new Error("tags did not parse to an array");
    tags.push("two");
    if (first) first.data.title = "Changed";

    const [second] = await loadPosts(files, cache);

    expect(cache.sets).toBe(1);
    expect(second?.data).toMatchObject({ title: "A", tags: ["one"] });
  });
});
