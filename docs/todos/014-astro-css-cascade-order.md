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

## Files

- `packages/pletivo/src/astro-css-order.ts`
- `packages/pletivo/src/astro-plugin.ts` — `astroCssMap`, `getAstroCssForPage()`
- `tests/conformance/fixtures/css-cascade-order/`
