import { defineCollection, glob, z } from "../../../packages/pletivo/src/content/collection";

export const collections = {
  blog: defineCollection({
    loader: glob({ base: "src/content/blog" }),
    schema: z.object({
      title: z.string(),
      date: z.coerce.date(),
      draft: z.boolean().default(false),
      tags: z.array(z.string()).optional(),
    }),
  }),
};
