# 024 — Astro's official examples, built by pletivo

**Priority:** S-tier
**Status:** open; 4 of 18 match (0 at baseline), framework renderers are the largest gap left
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

## After (main at 25631f6)

7 of 18 examples build with pletivo, **4 of 18 match**: basics,
container-with-vitest, minimal and with-vitest.

Fewer examples build than at baseline (10) on purpose. framework-preact,
framework-svelte and framework-vue used to build and emit a broken page, and
with-tailwindcss built and dropped its `.md` page's layout. These four now fail
the build, naming the file (#51, #59). blog builds now.

| example | pletivo builds | routes | pages equal | first difference |
|---|---|---|---|---|
| basics | yes | 2/2 | 1/1 | **match** |
| blog | yes | 14/14 | 0/8 | stylesheets under 4 kB: Astro inlines them, pletivo links them |
| container-with-vitest | yes | 4/4 | 2/2 | **match** |
| framework-alpine | yes | 2/2 | 0/1 | the page-script bundle: Astro links it (over 4096 B), pletivo inlines it |
| framework-multiple | no | | | fails by name: Preact, React, Solid, Svelte and Vue components |
| framework-preact | no | | | fails by name: Preact component |
| framework-react | no | | | fails by name: React component |
| framework-solid | no | | | fails by name: Solid component |
| framework-svelte | no | | | fails by name: Svelte component |
| framework-vue | no | | | fails by name: Vue component |
| minimal | yes | 2/2 | 1/1 | **match** |
| portfolio | yes | 34/34 | 0/8 | `<style>` set and order; `style={{…}}` as `[object Object]`; a random id |
| starlog | no | | | `astro:transitions` missing ([011](011-view-transitions.md)) |
| with-markdoc | no | | | fails by name: no Markdoc renderer for `.mdoc` entries |
| with-mdx | no | | | `Counter.jsx` compiled with React's JSX runtime, not Preact's (gap 4) |
| with-nanostores | no | | | fails by name: Preact component |
| with-tailwindcss | no | | | fails by name: `layout:` in a `.md` page's frontmatter |
| with-vitest | yes | 2/2 | 1/1 | **match** |

## Gaps and what closed them

Ordered by how many examples each one blocked at baseline.

1. **`public/` was hashed** (10 of 10 building). Fixed in #49 for Astro
   projects: `public/` is copied verbatim, as Astro does; `hashAssets: true`
   opts back in. Same decision as [017](017-dogfood-static-site.md) item 2.
2. **Fallback `sitemap.xml`** (10 of 10). Fixed in #49: an Astro project gets
   none unless `@astrojs/sitemap` is configured.
3. **Scoped style strategy** (8 of 10). Fixed in #52: the compiler runs with the
   project's `scopedStyleStrategy`, `attribute` by default as in Astro 5.
4. **Framework renderers** (preact, react, solid, svelte, vue, multiple,
   with-mdx, with-nanostores). Not fixed. Since #51 a component pletivo cannot
   render fails the build by file and framework, instead of a tag named by its
   path or `[object Object]`. Real renderers (each integration's server
   renderer, `<astro-island>` and Astro's client runtime, on both hosts) are
   the next piece of work and replace the error.
5. **Small hoisted scripts linked, Astro inlines them** (portfolio,
   framework-preact). Fixed in #54: a processed script whose bundle imports
   nothing and fits `vite.build.assetsInlineLimit` (4096 B, a function
   honoured) is inlined; each script is emitted once per page, deduped on the
   written HTML. Stylesheets are not covered; see Left.
6. One example each:
   - extensionless endpoint `src/pages/api.ts` (container-with-vitest):
     fixed in #50;
   - `injectScript("page")` emitted raw (framework-alpine): fixed in #60,
     bundled into one inline module by the Bun build, dev and `prepare`;
   - `.md` page `layout:` (with-tailwindcss): fails by name since #59; raw
     HTML in `.md` re-serialized as Astro's `rehype-raw` does in #56;
   - `astro/zod` version (blog): fixed in #57, one Zod per build, the
     project's Astro's own;
   - `Astro.url` undefined in a component inside MDX content (blog): fixed in
     #58, every host renders a page inside `runInPage`;
   - legacy collection without a loader (with-markdoc): fixed in #53, read from
     `src/content/<name>`; its `.mdoc` entries now fail by name;
   - `import.meta.env` outside `.astro` (with-nanostores): fixed in #55; the
     example now stops at its Preact components (gap 4);
   - `astro:transitions` (starlog): open, [011](011-view-transitions.md).

## Decisions

- **Unsupported framework components fail the build** (#51). A silent wrong
  render is a bug; the error stays until real renderers replace it.
- **`.md` page `layout:` fails by name** (#59). Full support changes how `.md`
  compiles on both hosts and waits for its own decision.
- **Page scripts inline** (#60). `injectScript("page")` scripts are bundled
  into one inline module; the artifact format stays unchanged. framework-alpine
  keeps one differing line, because Astro links that bundle once it passes
  4096 B.
- **One Zod per build** (#57). `astro/zod`, `astro:content`'s `z` and the
  `image()` / `reference()` helpers come from the project's Astro when it is
  installed.

## Left

Remaining differences in examples that build:

- Stylesheets under `assetsInlineLimit`: Astro inlines them
  (`build.inlineStylesheets: "auto"`), pletivo links every one (blog). The CSS
  chunk plan decides per page set, not per page, so this needs a change in how
  build CSS is planned.
- `style={{ … }}` on an element renders `[object Object]`; Astro serializes the
  object to CSS text (portfolio).
- A custom element's scope attribute: Astro writes `data-astro-cid-x="true"`,
  pletivo a bare attribute (portfolio).
- Inline `<style>` set and order differ (portfolio).
- `Icon.astro` in portfolio builds an id from `Math.random()`, so its pages can
  never compare equal without a normaliser rule for it.
- The page-script bundle is inlined regardless of size (framework-alpine, see
  Decisions).

Found on the way, not blocking an example:

- Markdoc rendering; for legacy collections, `render()` headings,
  `remarkPluginFrontmatter` and a custom `srcDir`.
- An `astro.config` that fails to load silently builds as a native project.
- `prepare` alone cannot load `astro/config` when `astro` is not installed.
- Workers: no Astro env built-ins; `api.ts` is classified by file name.
- A linked hoisted bundle's `public/` references are not rewritten where
  `public/` is hashed ([017](017-dogfood-static-site.md)).
- `.env` files are read by `NODE_ENV` (Bun's), not by the mode as Vite does.
- Some frontmatter Astro accepts is not recognized (a closing `---` at end of
  file, leading blank lines, TOML `+++`); such a page renders it as body text.
- No Vite plugin's `configResolved` runs, so `@astrojs/alpinejs`'s
  `entrypoint` option is never set.
