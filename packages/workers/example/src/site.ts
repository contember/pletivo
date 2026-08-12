/**
 * The demo project, as a virtual file map.
 *
 * This is the shape the real caller has: sources out of a Durable Object, a SQLite
 * row, or an agent's edit buffer. Nothing here ever touches a filesystem.
 */
export const SITE = new Map<string, string>([
  // Imported below, which is the only reason it reaches the bundle: the project
  // stylesheet is built from the CSS the module graph pulls in.
  [
    "src/styles/global.css",
    `@import "tailwindcss";

@theme {
  --color-brand: oklch(0.62 0.19 259);
}
`,
  ],
  [
    "src/components/Layout.astro",
    `---
import "../styles/global.css";
const { title } = Astro.props;
---
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>{title}</title>
  </head>
  <body class="mx-auto max-w-2xl p-8">
    <h1 class="text-3xl font-bold text-brand">{title}</h1>
    <slot />
  </body>
</html>
<style>
  body { font-family: system-ui, sans-serif; }
</style>
`,
  ],
  [
    "src/components/Card.astro",
    `---
const { heading } = Astro.props;
---
<article class="card mt-4">
  <h2 class="text-lg tracking-tight">{heading}</h2>
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
