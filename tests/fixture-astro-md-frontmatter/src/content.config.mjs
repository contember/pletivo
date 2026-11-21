import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

export const collections = {
  docs: defineCollection({
    loader: glob({ base: "src/content/docs", pattern: "*.md" }),
    schema: z.object({ title: z.string() }),
  }),
};
