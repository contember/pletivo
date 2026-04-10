import { defineCollection, glob, z } from "../../../packages/pletivo/src/content/collection";

const postSchema = z.object({
  title: z.string(),
  date: z.coerce.date(),
  draft: z.boolean().default(false),
  tags: z.array(z.string()).optional(),
});

export const collections = {
  blog: defineCollection({
    loader: glob({ base: "src/content/blog" }),
    schema: postSchema,
  }),
  docs: defineCollection({
    loader: glob({ base: "src/content/docs" }),
    schema: postSchema,
  }),
  notes: defineCollection({
    loader: glob({ base: "src/content/notes" }),
    schema: postSchema,
  }),
};
