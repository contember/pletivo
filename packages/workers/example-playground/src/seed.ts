/**
 * The project the playground starts from, as a virtual file map.
 *
 * The sources are real files under `project/`, so they can be edited with syntax
 * highlighting and rendered by a test off disk; wrangler's `Text` rules turn each
 * import into its source at bundle time. That is the whole build step — a `Map` in the
 * worker's heap, written into the Durable Object's SQLite the first time it is asked
 * for a page.
 *
 * `content.config.mjs` rather than `.ts` on purpose. A `.ts` file resolves as
 * TypeScript, so it cannot also be a text module: `tsc` reads the real file and reports
 * that it has no default export. Astro accepts either name.
 */

import globalCss from "../project/src/styles/global.css";
import contentConfig from "../project/src/content.config.mjs";
import baseLayout from "../project/src/layouts/BaseLayout.astro";
import postCard from "../project/src/components/PostCard.astro";
import prose from "../project/src/components/Prose.astro";
import indexPage from "../project/src/pages/index.astro";
import aboutPage from "../project/src/pages/about.astro";
import postPage from "../project/src/pages/posts/[...slug].astro";
import noBuildStep from "../project/src/content/posts/no-build-step.md";
import sqliteFilesystem from "../project/src/content/posts/sqlite-as-a-filesystem.md";
import tailwindFromHtml from "../project/src/content/posts/tailwind-from-rendered-html.md";
import typedCollections from "../project/src/content/posts/typed-content-collections.md";

/** Project-relative path -> source. The keys are what the editor shows. */
export const SEED: ReadonlyMap<string, string> = new Map([
  ["src/pages/index.astro", indexPage],
  ["src/pages/about.astro", aboutPage],
  ["src/pages/posts/[...slug].astro", postPage],
  ["src/layouts/BaseLayout.astro", baseLayout],
  ["src/components/PostCard.astro", postCard],
  ["src/components/Prose.astro", prose],
  ["src/styles/global.css", globalCss],
  ["src/content.config.mjs", contentConfig],
  ["src/content/posts/no-build-step.md", noBuildStep],
  ["src/content/posts/sqlite-as-a-filesystem.md", sqliteFilesystem],
  ["src/content/posts/tailwind-from-rendered-html.md", tailwindFromHtml],
  ["src/content/posts/typed-content-collections.md", typedCollections],
]);
