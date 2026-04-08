import { defineCollection, z } from "../../../packages/pavouk/src/content/collection";

export const collections = {
  blog: defineCollection({
    directory: "src/content/blog",
    schema: z.object({
      title: z.string(),
      date: z.coerce.date(),
      draft: z.boolean().default(false),
      tags: z.array(z.string()).optional(),
    }),
  }),
};
