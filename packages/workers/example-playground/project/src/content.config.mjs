import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

export const collections = {
  posts: defineCollection({
    loader: glob({ base: "src/content/posts" }),
    schema: z.object({
      title: z.string(),
      date: z.coerce.date(),
      description: z.string(),
      tags: z.array(z.string()).default([]),
      draft: z.boolean().default(false),
    }),
  }),
};
