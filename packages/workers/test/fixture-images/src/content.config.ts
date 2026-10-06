import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

export const collections = {
  products: defineCollection({
    loader: glob({ base: "src/content/products", pattern: "**/*.md" }),
    schema: ({ image }) => z.object({ title: z.string(), cover: image() }),
  }),
};
