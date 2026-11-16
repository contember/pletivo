import { defineCollection, reference, z } from "astro:content";
import { z as astroZod } from "astro/zod";
import { glob } from "astro/loaders";

export const collections = {
  authors: defineCollection({
    loader: glob({ base: "src/content/authors", pattern: "*.json" }),
    schema: astroZod.object({ name: astroZod.string() }),
  }),
  posts: defineCollection({
    loader: glob({ base: "src/content/posts" }),
    // `z` from both modules, image() and reference() nested in one object.
    schema: ({ image }) =>
      astroZod.object({
        title: z.string(),
        cover: image(),
        author: reference("authors"),
      }),
  }),
};
