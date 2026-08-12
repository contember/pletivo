# 019 — CSS chunking: what Astro does, and the spec pletivo needs

**Priority:** S-tier
**Status:** Open — specified, not implemented
**Area:** CSS pipeline

Companion to [017](017-dogfood-static-site.md) item 1. That entry records the
symptom on a real site; this one records the cause to the byte and the
specification for fixing it.

## The byte account

The site: 62 `.astro` files, 38 of them importing one `BaseLayout.astro` that
imports three `@fontsource` stylesheets. One emitted bundle,
`assets/styles.cb49acfe.css`, **23,452,896 B**, render-blocking on all 211 pages.

Recovered from Bun's `/* <file> */` markers, and independently confirmed: 117
`@fontsource` blocks in the output, **4 distinct contents** — appearing 39, 39,
38 and 1 times.

| # | cause | bytes | % |
|---|---|---|---|
| 1 | 38 redundant copies of a 598,563 B font chunk (39 emitted, 1 needed) | 22,745,394 | 96.99 |
| 2 | base64 `data:` URIs in the one kept copy (26 fonts, 16 `@font-face`) | 593,652 | 2.53 |
| 3 | no minification | 20,598 | 0.09 |
| 4 | raw re-emit of `src/styles/global.css` — see below | 13,880 | 0.06 |
| 5 | irreducible minified CSS | 79,372 | 0.34 |
| | **total** | **23,452,896** | 100 |

Sorting the file's unique lines gives 670,914 B — a 35× duplication ratio.
624 `@font-face` rules where the source has 16, which is exactly 39×.

**pletivo's actual CSS content is ~7 kB smaller than Astro's 86 kB.** 99.66% of
the file is mechanism, not styles.

Row 2 breaks down as 444,776 B of woff2/woff on disk plus **148,876 B (33.5%) of
base64 overhead**. The site's own `public/_headers` sets `font-src 'self'` with
no `data:`, so every one of those `@font-face` rules would be **CSP-blocked in
production**.

## Mechanism, in pletivo

- **Per-importer keying.** `astro-plugin.ts:438` keys `moduleCssMap` by importer
  (`astro:${rel}`), one entry per `.astro` file. `js-imported-css.ts:303-328`
  walks imports transitively, so every page importing `BaseLayout` inherits its
  three font specifiers. `:172` stores the full CSS *text* per key, and `:51`
  joins them with no `Set` and no hashing. **Dedup is not attempted.** All 39
  values are byte-identical, so a content-keyed `Set` at `:51` would collapse
  them as they stand.
- **Base64 is a Bun default, with no escape hatch.** `js-imported-css.ts:151-157`
  calls `Bun.build` with no `loader`, no `outdir`, no `publicPath`. Bun 1.3.14
  inlines CSS `url()` assets ≤ 131,071 B as `data:` and emits files at
  ≥ 131,072 B. Adding `outdir` or `loader: {".woff2": "file"}` does not change
  it — both tested. pletivo has no `assetsInlineLimit` equivalent anywhere.
- **Minify is explicitly off** at `js-imported-css.ts:155`, and `css.ts:41`
  writes the result verbatim. `css.ts:166` returns Tailwind's `result.build()`
  without `optimize()`.
- **One bundle for all pages is deliberate** (`css.ts:17-44`, `build.ts:839`,
  `build.ts:1344`). The size is the bug, not the single-file design per se — but
  see the spec below, where per-page grouping is what removes the duplication.

## Separately: `global.css` ships twice, and the second copy is unlayered

Not a size problem — a cascade one. `css.ts:80` sets
`includesAllSourceCss: false` on the Tailwind path, so `css.ts:24` passes
`includeSourceCss: true` and `readSourceCssOutput` re-emits the same file raw.
The bundle therefore contains `src/styles/global.css` twice: once compiled into
the Tailwind block, and once verbatim — including `@import "tailwindcss";`,
`@theme` and `@utility`, which a browser cannot use. Confirmed: the emitted
stylesheet contains `@import "tailwindcss";` at line 9532.

The raw copy is **last and unlayered**, so a rule like `.prose-body tbody td`
there outranks the layered compiled copy. That is a live cascade hazard, and it
is currently hidden behind the size problem.

## What Astro does

Verified against the installed 4.16.19 and the 5.16.11 checkout (the chunking,
inlining and ordering code is byte-equivalent between them). On this same site:
5 chunks — 2 written (81,335 B on all 211 pages; 5,258 B on 26) and 3 inlined and
deleted (158 B on 93 pages, 252 B on 30, 118 B on 1). Worst page: 86,593 B.

The chunk unit is **the set of top-level page modules that can reach the CSS
module** — not the page, not a dynamic-import boundary
(`core/build/plugins/plugin-css.ts:63-101`, a Rollup `manualChunks` "after"
hook). Deduplication is structural: `manualChunks` is a total module→chunk
function, so a module physically lives in exactly one chunk. The reverse map of
which pages link which chunk is built by walking each chunk's modules back up to
pages (`plugin-css.ts:128-152`).

## The specification

Marked by what each buys.

**Required for correctness**

1. Build a module graph over page entries. For each CSS module compute the set of
   page entries reaching it, statically or dynamically; group CSS modules by that
   set. One stylesheet per group. *This alone is 23.4 MB → ~86 kB.*
2. Emit each CSS module's text exactly once, into its group's file only.
3. Each page links every group whose page-set contains it — nothing more.
4. Order rules inside a group by one deterministic post-order traversal over the
   group's merged graph, deduplicated — not per page.
5. Sort a page's links by `(order asc, depth desc)` with `-1` sentinels at the
   ends (`core/build/internal.ts:264-287`); min-reduce `order`/`depth` when a
   module is reachable by several paths.
6. De-duplicate at render: skip a `<link>` whose href is already present, and a
   `<style>` whose content is (`runtime/server/render/tags.ts:12-21`).

**Required only for size parity**

7. Inline a stylesheet as `<style>` iff `byteLength < 4096`; config
   `auto`/`always`/`never`, default `auto`
   (`core/config/schemas/base.ts:66`, `plugins/util.ts:110-124`).
8. Inline a CSS-referenced asset as `data:` iff raw length `< 4096` — Vite's
   `build.assetsInlineLimit` default, which Astro never overrides. Never for
   `.html` or fragment-referenced `.svg`. **pletivo cannot do this with a
   `Bun.build` flag**; it needs post-processing of the returned CSS.
9. Minify with esbuild in production; Astro forces it on in the SSR build
   (`core/build/static-build.ts:156-158`).
10. Merge adjacent inline sheets before rendering (`internal.ts:289-303`).

**Cosmetic**

11. Chunk filename = prettified basename of the first non-`404`/`500` parent page
    plus a content hash; content-collection-propagated CSS gets its own chunk.

## What a Bun implementation cannot reproduce exactly

- **Rollup's within-chunk module order** (item 4). Bun exposes no
  `manualChunks`/`chunk.modules` equivalent. Closest: a DFS post-order over the
  union of the group's page graphs, visiting pages in sorted order, emitting each
  module on first reach. Matches Rollup for the single-parent case; can differ
  when two pages import shared modules in conflicting orders — rarely observable
  in the cascade, but real.
- **Vite's asset-URL rewriting inside CSS** (item 8) rides on its
  `emitFile`/`__VITE_ASSET__` placeholder round-trip. Resolving `url()` targets
  against the emitting file's directory and substituting hashed paths produces
  identical observable output.
- **`augmentChunkHash`** folding `importedCss` into JS chunk hashes has no Bun
  analogue; hashing the CSS reference list into pletivo's own chunk hash
  reproduces the cache-busting effect.

## The cheap patch, and why it is not the fix

A content-keyed `Set` at `js-imported-css.ts:51` takes **23,452,896 → 707,502 B
(−96.99%) in one line**, losslessly here, because all 39 values are provably
byte-equal and the survivor keeps the earliest position so cascade order is
unchanged.

It is still a patch. It leaves 39 redundant `Bun.build` invocations, and it only
works while the duplicated values are identical — grouping by page-set (item 1)
is what actually makes the output correct. With fonts as files it would reach
~113,850 B and with minification ~79,372 B.
