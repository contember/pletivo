import { describe, expect, test } from "bun:test";
import { z as z3 } from "zod/v3";
import { z as z4 } from "zod";
import {
  createContentRuntime,
  defineCollectionWith,
  getCollection,
  getValidationFailures,
  glob,
  initCollections,
  referenceWith,
  runWithContentRuntime,
  type CollectionConfig,
  type ContentHost,
} from "@pletivo/core/content/collection";

/** One `post.md` with `frontmatter`, and an image resolver that finds nothing. */
function host(collections: Record<string, CollectionConfig>, frontmatter: string): ContentHost {
  return {
    async scan(_projectRoot, base) {
      return {
        root: base,
        rootUrl: new URL(`file:///${base}/`),
        files: [{ entry: "post.md", path: `${base}/post.md` }],
      };
    },
    async readFile() {
      return `---\n${frontmatter}\n---\nBody`;
    },
    dirname: (file) => file.slice(0, file.lastIndexOf("/")),
    resolveDir: (_projectRoot, base) => base,
    async loadConfig() {
      return collections;
    },
    async resolveImage(_dir, relativePath) {
      throw new Error(`image not found: ${relativePath}`);
    },
  };
}

const defineZod3Collection = defineCollectionWith(z3);

describe("a collection whose schema is Zod 3 (Astro 5's astro:content)", () => {
  test("reports reference() and image() failures as issues, not as a Zod 4 error check", async () => {
    const runtime = createContentRuntime(
      host(
        {
          posts: defineZod3Collection({
            loader: glob({ base: "content" }),
            schema: ({ image }) =>
              z3.object({ author: referenceWith(z3, "authors"), cover: image() }),
          }),
        },
        "author: 5\ncover: ./missing.png",
      ),
    );
    const failures = await runWithContentRuntime(runtime, async () => {
      await initCollections("/project");
      expect(await getCollection("posts")).toEqual([]);
      return getValidationFailures();
    });
    expect(failures).toHaveLength(1);
    expect(failures[0].errors).toContain(
      'author: Expected an entry id of collection "authors", { id, collection } or { slug, collection }',
    );
    expect(failures[0].errors).toContain("cover: image not found: ./missing.png");
  });

  test("a schema built with another Zod major fails with a hint at the cause", async () => {
    const runtime = createContentRuntime(
      host(
        {
          posts: defineZod3Collection({
            loader: glob({ base: "content" }),
            schema: ({ image }) => z4.object({ cover: image() }),
          }),
        },
        "cover: ./cover.png",
      ),
    );
    await runWithContentRuntime(runtime, async () => {
      await initCollections("/project");
      await expect(getCollection("posts")).rejects.toThrow(
        "image() and reference() from astro:content use Astro's own Zod",
      );
    });
  });
});
