// Two collections in one project: a mixed .md/.mdx document collection and a
// YAML data collection. No existing fixture combines them, and the fixtures
// that do load YAML write their content.config.ts at test time, so they cannot
// be built standalone.
import { defineCollection, glob, z } from "../../../../../packages/pletivo/src/content/collection";

export const collections = {
  docs: defineCollection({
    loader: glob({ base: "src/content/docs", pattern: "**/*.{md,mdx}" }),
    schema: z.object({
      title: z.string(),
      order: z.number(),
      tags: z.array(z.string()).default([]),
    }),
  }),
  data: defineCollection({
    loader: glob({ base: "src/content/data", pattern: "**/*.yaml" }),
    schema: z.object({
      title: z.string(),
      nav: z.array(z.object({ label: z.string(), href: z.string() })),
      defaults: z.object({ adapter: z.string(), host: z.string() }),
      staging: z.object({ adapter: z.string(), host: z.string(), database: z.string() }),
      tagline: z.string(),
      banner: z.string(),
      flags: z.array(z.string()),
    }),
  }),
};
