# 024 — Astro's official examples, built by pletivo

**Priority:** S-tier
**Status:** open; baseline measured, fixes landing one gap per PR
**Area:** Astro compatibility, measured

`tests/astro-examples/run.ts` builds every static-site example in
`withastro/astro` at `astro@5.16.11` twice, once with `astro build` and once with
`pletivo build`, and compares the output. Five examples are skipped as not static
sites (`hackernews`, `ssr`: SSR with the node adapter; `component`,
`integration`, `toolbar-app`: packages). That leaves 18.

```bash
bun tests/astro-examples/run.ts --astro ~/path/to/astro-checkout
bun tests/astro-examples/run.ts --compare-only     # re-compare the last outputs
diff -r $TMPDIR/pletivo-astro-examples/<example>/normalized/{astro,pletivo}
```

An example **matches** when both emit the same route list (every file outside
the bundle directories: pages, endpoint output, `public/` copies) and every route
is equal. Other text routes (`.xml`, `.txt`, `.json`) are compared as written;
pages are compared after a normaliser that erases only what two correct builds
may disagree on:

- whitespace a browser does not render: runs collapse to one space, and none is
  kept next to a block-level tag. A space next to an inline element (islands and
  `<picture>` included) stays; `<pre>`, `<textarea>`, `<script>` and `<style>`
  content is compared as is;
- the `<meta name="generator">` value;
- bundled asset URLs, each side's own only (Astro's `_astro/`; pletivo's
  `_astro/`, `_islands/` and `assets/*.css`): directory and hash always, and the
  chunk name of CSS and JS. An image or font keeps its name. Every distinct URL
  gets an ordinal, so two chunks or two `srcset` widths stay distinct;
- scope-id hash values, as ordinals, so the element ↔ selector link still counts;
- CSS minifier spelling: both sides' `<style>` text goes through the esbuild
  Astro's Vite minified with.

Bundled CSS and JS contents are not compared. A successful Astro build is cached
per example, keyed by the example's files.

## Baseline (main at 50f78dc)

10 of 18 examples build with pletivo, **0 of 18 match**. Routes are common/Astro's,
`+n` the routes only pletivo emits (a hashed `public/` file counts there).

| example | pletivo builds | routes | pages equal | first difference |
|---|---|---|---|---|
| basics | yes | 1/2 +2 | 0/1 | scope strategy: `data-astro-cid-*` vs `class="astro-*"` |
| blog | no | | | `@astrojs/rss`: `z.function().returns is not a function` (`astro/zod` is zod 4) |
| container-with-vitest | yes | 2/4 +2 | 0/2 | missing `api` (extensionless endpoint), `favicon.svg` |
| framework-alpine | yes | 1/2 +2 | 0/1 | injected page script emitted raw, bare `import "alpinejs"` |
| framework-multiple | no | | | `solid-js` has no `jsxDEV` (no Solid renderer) |
| framework-preact | yes | 1/2 +2 | 0/1 | Preact component rendered as `[object Object]` |
| framework-react | no | | | `dispatcher.useState` of null (no React renderer) |
| framework-solid | no | | | `solid-js` has no `jsxDEV` (no Solid renderer) |
| framework-svelte | yes | 1/2 +2 | 0/1 | Svelte component emitted as a tag named by its absolute path |
| framework-vue | yes | 1/2 +2 | 0/1 | Vue component emitted as a tag named by its absolute path |
| minimal | yes | 1/2 +2 | 0/1 | `public/favicon.svg` hashed |
| portfolio | yes | 8/34 +27 | 0/8 | 26 `public/` files hashed; small scripts linked, Astro inlines them |
| starlog | no | | | `astro:transitions` missing ([011](011-view-transitions.md)) |
| with-markdoc | no | | | `defineCollection({})` with no loader (Astro 5 falls back to `src/content/<name>`) |
| with-mdx | no | | | `Counter.jsx` compiled with React's JSX runtime, not Preact's |
| with-nanostores | no | | | `import.meta.env.BASE_URL` undefined in a `.ts` module |
| with-tailwindcss | yes | 2/3 +2 | 0/2 | `.md` page layout loses `<html lang>` and `<meta viewport>` |
| with-vitest | yes | 1/2 +2 | 0/1 | `public/favicon.svg` hashed |

## Gaps, by how many examples they block

Every buildable example hits the first three, so nothing can match until they are
fixed.

1. **`public/` is hashed** (10 of 10 building). Astro copies `public/` verbatim;
   pletivo renames every file and rewrites the references it can see. Same
   decision as [017](017-dogfood-static-site.md) item 2. Fixed in #49 for
   Astro projects.
2. **Fallback `sitemap.xml`** (10 of 10). pletivo writes one unless
   `@astrojs/sitemap` is configured; Astro writes none. Fixed in #49 for Astro
   projects.
3. **Scoped style strategy** (8 of 10). Astro 5 defaults `scopedStyleStrategy`
   to `attribute` (`[data-astro-cid-x]`, specificity 0-1-0); pletivo leaves the
   compiler at `where` (`:where(.astro-x)`, specificity 0). A cascade
   difference, not only a markup one.
4. **Framework renderers** (7: preact, react, solid, svelte, vue, multiple,
   with-mdx; with-nanostores after its own fix). `addRenderer()` is a no-op;
   pletivo renders JSX components itself. A Svelte or Vue component comes out
   as a tag named by its absolute file path
   (`</abs/src/components/Counter.svelte client:visible …>`), a Preact one as
   `[object Object]`, both silently; React and Solid crash.
5. **Small hoisted scripts and stylesheets are linked, Astro inlines them**
   (portfolio, framework-preact).
6. One example each: extensionless endpoint (container-with-vitest),
   `injectScript("page")` not bundled (framework-alpine), `.md` page layout
   (with-tailwindcss), `astro/zod` version (blog), legacy collection without a
   loader plus Markdoc entries (with-markdoc), `import.meta.env` outside `.astro`
   (with-nanostores), `astro:transitions` (starlog).
