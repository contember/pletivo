import { describe, test, expect } from "bun:test";
import { defineCollection, glob } from "../../packages/pavouk/src/content/collection";
import { z } from "zod";

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
    expect(result.loader!.load).toBeTypeOf("function");
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
});
