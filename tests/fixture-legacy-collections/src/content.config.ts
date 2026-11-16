import { defineCollection, z } from "../../../packages/pletivo/src/content/collection";

// No loader: Astro 5 reads these from src/content/<name>/.
export const collections = {
  docs: defineCollection({}),
  authors: defineCollection({ type: "data", schema: z.object({ name: z.string() }) }),
};
