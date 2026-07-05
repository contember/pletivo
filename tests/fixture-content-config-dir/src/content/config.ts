import { defineCollection, glob, z } from "../../../../packages/pletivo/src/content/collection";

export const collections = {
  configured: defineCollection({
    loader: glob({ base: "src/content/configured" }),
    schema: z.object({
      title: z.string(),
    }),
  }),
};
