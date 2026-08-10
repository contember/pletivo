import { describe, test, expect } from "bun:test";
import path from "path";
import { defineCollection, glob, type Loader } from "../../packages/pletivo/src/content/collection";
import { z } from "zod";

const fixtureRoot = path.join(import.meta.dir, "../fixture");

describe("defineCollection", () => {
  test("returns the same config object", () => {
    const schema = z.object({ title: z.string() });
    const config = { directory: "src/content/blog", schema };
    const result = defineCollection(config);
    expect(result).toBe(config);
  });

  test("preserves directory and schema", () => {
    const schema = z.object({ title: z.string(), order: z.number() });
    const result = defineCollection({ directory: "content/docs", schema });
    expect(result.directory).toBe("content/docs");
    expect(result.schema).toBe(schema);
  });

  test("accepts transform function", () => {
    const transform = (html: string) => html.replace(/<h1>/g, '<h1 class="title">');
    const result = defineCollection({
      directory: "content/blog",
      schema: z.object({ title: z.string() }),
      transform,
    });
    expect(result.transform).toBe(transform);
  });

  test("directory sugar creates glob loader", () => {
    const result = defineCollection({
      directory: "src/content/blog",
      schema: z.object({ title: z.string() }),
    });
    expect(result.loader).toBeDefined();
    expect((result.loader as Loader).load).toBeTypeOf("function");
  });

  test("glob stamps __globBase (used to watch content outside src/)", () => {
    const loader = glob({ base: "content/references" });
    expect(loader.__globBase).toBe("content/references");
  });

  test("directory sugar exposes __globBase on the created loader", () => {
    const result = defineCollection({ directory: "content/docs", schema: z.object({ title: z.string() }) });
    const loader = result.loader;
    expect(loader && "__globBase" in loader ? loader.__globBase : undefined).toBe("content/docs");
  });

  test("explicit loader takes precedence over directory", () => {
    const customLoader = { load: async () => [] };
    const result = defineCollection({
      directory: "src/content/blog",
      loader: customLoader,
      schema: z.object({ title: z.string() }),
    });
    expect(result.loader).toBe(customLoader);
  });

  test("glob() returns a loader", () => {
    const loader = glob({ base: "src/content/blog" });
    expect(loader.load).toBeTypeOf("function");
  });

  test("glob() with custom pattern", () => {
    const loader = glob({ base: "content", pattern: "**/*.mdx" });
    expect(loader.load).toBeTypeOf("function");
  });

  test("glob() default IDs strip extension and preserve subdirs", async () => {
    const loader = glob({ base: "src/content/news" });
    const entries = await loader.load(fixtureRoot);
    const ids = entries.map((e) => e.id).sort();
    expect(ids).toEqual(["cs/brno-1", "cs/praha-2", "en/prague-2"]);
  });

  test("glob() generateId overrides the default ID", async () => {
    const loader = glob({
      base: "src/content/news",
      generateId: ({ entry }) => `custom:${entry}`,
    });
    const entries = await loader.load(fixtureRoot);
    const ids = entries.map((e) => e.id).sort();
    expect(ids).toEqual([
      "custom:cs/brno-1.md",
      "custom:cs/praha-2.md",
      "custom:en/prague-2.md",
    ]);
  });

  test("glob() generateId receives parsed frontmatter data", async () => {
    const loader = glob({
      base: "src/content/news",
      generateId: ({ data }) => `t-${(data as { title: string }).title}`,
    });
    const entries = await loader.load(fixtureRoot);
    const ids = entries.map((e) => e.id).sort();
    expect(ids).toEqual(["t-Brno 1", "t-Prague 2", "t-Praha 2"]);
  });
});
