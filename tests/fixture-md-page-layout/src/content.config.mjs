import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

export const collections = {
  posts: defineCollection({
    loader: glob({ pattern: "**/*.md", base: "./src/content/posts" }),
    // In a collection entry `layout` is plain data, not a page layout.
    schema: z.object({ title: z.string(), layout: z.string() }),
  }),
};
