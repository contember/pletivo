/**
 * The demo project, as a virtual file map.
 *
 * This is the shape the real caller has: sources out of a Durable Object, a SQLite
 * row, or an agent's edit buffer. Nothing here ever touches a filesystem.
 */
export const SITE = new Map<string, string>([
  [
    "src/components/Layout.astro",
    `---
const { title } = Astro.props;
---
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>{title}</title>
  </head>
  <body>
    <h1>{title}</h1>
    <slot />
  </body>
</html>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 40rem; }
</style>
`,
  ],
  [
    "src/components/Card.astro",
    `---
const { heading } = Astro.props;
---
<article class="card">
  <h2>{heading}</h2>
  <slot />
</article>
<style>
  .card { border: 1px solid #ccc; border-radius: 8px; padding: 1rem; }
</style>
`,
  ],
  [
    "src/pages/index.astro",
    `---
import Layout from "../components/Layout.astro";
import Card from "../components/Card.astro";
---
<Layout title="Rendered in a Worker">
  <Card heading="No sandbox">
    <p>These sources live in memory. A Worker Loader isolate ran the compiled page.</p>
  </Card>
</Layout>
`,
  ],
  [
    "src/pages/about.md",
    `---
title: About
---

# About

Markdown never reaches the isolate — it is a string transform, so it runs in this
worker through \`@pletivo/core\`.
`,
  ],
]);
