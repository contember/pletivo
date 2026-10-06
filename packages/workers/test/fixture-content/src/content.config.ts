// Written the way a real project writes it — `astro:content` and `astro/loaders`,
// not a relative path into this repo. Both hosts answer to those specifiers: the Bun
// host through `astro-plugin.ts`'s virtual modules, the Workers host through
// `compileProject`, which points them at the one bundled content module.
//
// Two collections, two parse branches: markdown with frontmatter, and JSON. A
// `reference()` runs between them, so the fixture also covers the id-marker round
// trip that `getEntry(ref)` resolves.
import { defineCollection, reference, z } from "astro:content";
import { glob } from "astro/loaders";

export const collections = {
  posts: defineCollection({
    // No `pattern`: the default `**/*.{md,mdx}` is the one a project inherits, so it
    // is the one whose translation into the Workers host's matcher has to agree.
    loader: glob({ base: "src/content/posts" }),
    schema: z.object({
      title: z.string(),
      date: z.coerce.date(),
      author: reference("authors"),
      // A default, so an entry that omits it still validates identically on both
      // hosts — the schema runs where the page runs.
      draft: z.boolean().default(false),
      tags: z.array(z.string()).default([]),
    }),
  }),
  authors: defineCollection({
    loader: glob({ base: "src/content/authors", pattern: "**/*.json" }),
    schema: z.object({
      name: z.string(),
      site: z.string(),
    }),
  }),
};
