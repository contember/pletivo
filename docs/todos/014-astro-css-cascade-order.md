# 014 — Hoisted `.astro` CSS emission order

**Priority:** S-tier
**Status:** Done (commits `1bf8686`, `a48fc9f`) — **changes rendered output**
**Area:** CSS / Rendering

## Problem

Hoisted `<style>` blocks were concatenated in `scopedCssMap` / `globalCssMap`
insertion order — the order Bun's `onLoad` happened to compile each `.astro`
file. Page renders run concurrently, so that order flipped between builds: 20
builds of `tests/fixture-astro-styles` produced 3 different `<style>` orderings.

CSS cascade order decides what the page looks like. This was not a test-output
wobble; the same sources rendered differently on different builds.

A second, deterministic bug hid underneath it: splitting scoped and global
blocks into two maps emitted **every** global block of the page ahead of
**every** scoped one. Two blocks written in one file came out in the opposite
order to how they were written.

## What the cascade requires

The order the page's ESM graph executes its style imports in — a depth-first
post-order walk of the static import graph rooted at the page module. That is
what Astro emits via Vite/Rollup, so it is what existing sites are written
against.

Verified against Astro 5.18 on the same sources:

- a page's own styles land after the CSS of the components it imports (the page
  wins ties against its layout)
- siblings follow the importer's import order, not render order
- a deeper component precedes the one importing it

## What changed

- `astro-css-order.ts` records each `.astro` module's imports from compiler
  output the loader already holds, then answers the walk lazily — a page with
  fewer than two CSS-contributing components never walks. What the walk cannot
  reach (`.mdx` imports) falls back to render order, never to map insertion
  order.
- `scopedCssMap` / `globalCssMap` merged into one per-file list, so a file's
  blocks keep source order.
- Conformance fixture `css-cascade-order` pins all of it. Each page separates
  the import graph from something that could be mistaken for it, so a
  regression to loader order or to render order fails loudly.

## Migration risk — read before upgrading

**Sites that happened to depend on the old ordering will render differently.**
The old order was wrong in two ways (nondeterministic across builds, and
globals hoisted above scoped blocks), so a site tuned against it — e.g. a
`is:global` reset written *after* a scoped rule and relying on winning the tie —
loses that tie now. There is no compatibility flag; the previous behaviour is
not reproducible by design, since it was not stable in the first place.

## Known divergence from Astro 5

Astro 5.18 emits a file's own blocks reversed (`is:global` before scoped). That
is `@astrojs/compiler` 2.13 handing back `result.css[]` in reverse source order,
fixed in compiler 3 — the version pletivo pins. Pletivo follows source order;
the conformance snapshot records the divergence deliberately.

## Source CSS without Tailwind

The same order applies to the stylesheets a module imports, not only to the
hoisted blocks. Without a Tailwind entry, `buildCss` puts every
`src/**/*.css` in the shared sheet. It used to sort them by path, so a page that
imports `z.css` and then a component that imports `a.css` got `.a` before `.z`.
Astro gives `.z` first.

`concatSourceCss` now orders the sheet like this:

- **Per page, Astro's order.** Each page's walk is depth-first post-order from
  the page module. Checked against Astro 5.16 on nested `.astro`, `.js` and
  `.jsx` importers, a CSS import between module imports, and one sheet reached
  twice.
- **Across pages, a topological merge into one shared sheet**
  (`importOrderedCss`). Each pair of files a page reaches one after the other
  is an edge; ties go to first-seen position, the pages walked in path order.
  `about` importing `components.css` alone does not put it ahead of the `base.css`
  that `index` imports first.
- **Conflicts.** Astro links a sheet per page; pletivo links one. When two pages
  order the same files differently, no single order serves both. Those files (a
  cycle in the merge) keep first-seen order. Example: `index` imports `y c`,
  `post` imports `z`, a component importing `c`, then `y`. The sheet is
  `z y c`: right for `index`, while `post` gets `y` before `c`. Splitting the
  fallback into per-page sheets would fix it; that changes the sheet layout and
  is not done.
- **`@import` between source files.** A file another source file `@import`s
  without conditions is emitted depth-first just before its importer, and the
  `@import` is dropped: Vite inlines it the same way. A page importing
  `x.css` and `g.css`, where `g.css` imports `v.css` and `r.css`, gets
  `x v r g`. Before, the file shipped by path order and the `@import` stayed,
  resolving against `/assets/` to a 404. An `@import` with `layer()`,
  `supports()` or a media query is not inlined.
- **Every other `@import`** (a URL, a package, a conditional one) and the first
  `@charset` move to the top of the sheet in order, as Vite hoists them. An
  `@import` below a rule is invalid and the browser drops it. Hoisting it above an
  `@layer` statement can change the layer order, as it does in Vite.
- **Files no page imports** still ship, first and in path order, unless another
  source file `@import`s them. Astro drops them, and so does the Tailwind path,
  apart from the entry and its `@import`s. Sites built on the fallback may rely
  on them.

Which sheet a rule lands in does not change: the fallback's files stay in the
shared sheet.

Pinned by "source CSS without Tailwind follows the import graph" in
`tests/e2e/css-chunking.test.ts`. That includes a warm `--incremental` build
equal to a full one.

Still different from Astro:

- `pletivo dev` registers no page entries, so it serves the fallback in path order.
- CSS Modules and CSS from outside `src/` come after all source CSS: the page
  groups, and the shared sheet's unattributed part, follow `base`. That predates
  this change.
- The page groups (CSS outside `src/`) are ranked by first-seen position, not
  by the merge. `about` importing `vendor/components.css` alone still puts it
  ahead of the `vendor/base.css` that `index` imports first.

## Files

- `packages/pletivo/src/astro-css-order.ts`
- `packages/pletivo/src/css.ts` — `concatSourceCss()`, the fallback; `js-imported-css.ts` — `importOrderedCss()`
- `packages/pletivo/src/astro-plugin.ts` — `astroCssMap`, `getAstroCssForPage()`
- `tests/conformance/fixtures/css-cascade-order/`
