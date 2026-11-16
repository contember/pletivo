import { defineCollection, reference, z } from "../../../packages/pletivo/src/content/collection";

// No loader: Astro 5 reads these from src/content/<name>/.
export const collections = {
  docs: defineCollection({}),
  authors: defineCollection({ type: "data", schema: z.object({ name: z.string() }) }),
  strict: defineCollection({ schema: z.object({ title: z.string() }).strict() }),
  dup: defineCollection({}),
  refs: defineCollection({ type: "data", schema: z.object({ doc: reference("docs") }) }),
  // No src/content/missing/ on purpose.
  missing: defineCollection({}),
};
