# 017 — Dogfood: a real production Astro site through the Bun host

**Priority:** S-tier (items 1–3), A-tier (4–6)
**Status:** Open — findings only, nothing fixed
**Area:** Build output / CSS / images / markdown

The site: 62 `.astro` files, Astro 4.16 on the Content Layer API, Tailwind 4 via
`@tailwindcss/vite`, `astro-icon`, `@astrojs/sitemap` with a `filter`, a custom
rehype plugin, `image()` in collection schemas, 9 `getStaticPaths` pages, 2
endpoint routes, no islands.

**It built with zero edits to the project**, first invocation, exit 0, no
warnings — all 211 routes Astro produces, plus both endpoints. That is the
headline and it is genuinely good.

**But 0 of 211 pages are byte-identical**, and three of the divergences would
break the deployed site. None of them produced an error; every one is silent.

## 1. The CSS bundle is 23.4 MB, render-blocking, on every page

Astro emits 81 kB + 5 kB, route-split. Three bugs compound:

- **No cross-module dedup.** `getJsImportedCssOutput` concatenates
  `moduleCssMap` per module, and `collectCssSpecifiersFromImports`
  (`js-imported-css.ts:303`) walks transitively — so all 39 `.astro` modules
  that reach `BaseLayout.astro` each carry a full copy of its CSS. Result: 624
  `@font-face` rules for 16 in source.
- **Fonts inlined as base64 `data:` URIs** — 1014 of them — instead of emitted
  as files. Astro writes 484 kB of woff2. **The site's own `public/_headers`
  sets `font-src 'self'`, so these would be CSP-blocked in production.**
- **Not minified.** 298 kB even with the base64 stripped.

This is not an Astro-compat gap. It is a correctness and performance bug that
hits any site with a shared layout, and it scales with the number of pages.

**Fully accounted for in [019](019-css-chunking.md)**, byte by byte, together
with what Astro does instead and the specification for matching it. Headline:
96.99% of the file is 38 redundant copies of one 598,563 B chunk, pletivo's
actual CSS content is ~7 kB *smaller* than Astro's, and the same bundle also
ships `global.css` a second time unlayered — a cascade hazard hiding behind the
size problem.

Also confirmed byte-identical on `main`, same content hash: this predates the
package split entirely.

## 2. `public/` assets are hashed, absolute URLs are not rewritten

`public/img/virivky-s-prelivem.jpg` ships as `virivky-s-prelivem.c9c28869.jpg`,
but `og:image` / `twitter:image`, built as `${SITE}/img/...`, still point at the
unhashed name — **404 on 48 pages**.

Astro copies `public/` verbatim, so this class of breakage cannot occur there.
Hashing `public/` at all is a pletivo choice; if it stays, absolute URLs built in
user code cannot be rewritten, so the two decisions are in conflict.

**Confirmed independently on a second project** — see
[018](018-dogfood-ssr-dev-server.md) item 3, where CSS `url()` references to
hashed public assets 404, taking both custom webfonts with them. Two unrelated
sites, one decision. This is the first thing to reconsider.

**Resolved for Astro projects:** a project with an Astro config now copies
`public/` verbatim, as Astro does; `hashAssets: true` in `pletivo.config` opts
back in. pletivo-native projects still hash. The Workers host already served
`public/` verbatim (`public-files.ts`), so for an Astro project both hosts now
agree.

**Known divergence, inline vs linked scripts,** wherever `public/` is still
hashed. A processed `<script>` inlined into the page (item 7) goes through the page's public-asset rewrite, so
`"/logo.png"` in its code becomes the hashed name. A linked
`_astro/hoisted-<hash>.js` bundle is never rewritten and keeps `"/logo.png"`,
which 404s. A script's public references therefore break once its bundle grows
past the inline limit. The linked side is the older bug; fixing it means running
the rewrite over hoisted bundles too.

## 3. Responsive images are silently dropped

1873 `srcset` attributes in Astro's output, **0** in pletivo's.

Verified in source: `sharpImageService()` — the default —
(`packages/core/src/image-service.ts:63`) does not set `supportsResponsive`.
Only `cloudflareImageService` does (line 94). `packages/pletivo/src/image.ts:466`
gates the whole `widths` branch on that flag, so `widths={[...]}` is accepted and
ignored on 9 components.

A one-line fix in the service definition, but only if sharp can actually produce
the variants — that is the part to check before flipping it.

## 4. Markdown plugins never receive frontmatter

`renderMarkdown` (`packages/core/src/content/markdown.ts:159`) calls
`processor.process(body.trim())` — a bare string. Astro's contract is that
plugins read `file.data.astro.frontmatter`, so any plugin depending on it gets
`undefined`.

Verified in source. On this site `rehypeTechLinks` uses it to suppress
self-links, producing **11 anchors linking a page to itself**.

The plugin runs, so nothing errors. It just silently sees nothing.

## 5. No smartypants

Astro 4 defaults `markdown.smartypants: true`. pletivo has no implementation, so
curly quotes stay straight on 15 markdown pages — the only text difference there.

## 6. `getCollection` order differs from Astro — deliberately

pletivo sorts the glob scan by filename; Astro returns filesystem traversal
order. This is the determinism fix documented on `ContentScan.files`: unsorted,
`getCollection()` returns a different order on ext4 than on tmpfs, and a second
host cannot agree with Bun.

So this divergence is a **trade-off we chose**, not a defect — but it does change
rendered output (`/faq` renders its Q&A and its `FAQPage` JSON-LD in a different
sequence), and anyone comparing against Astro should know why.

## 7. Hoisted scripts are neither merged nor hoisted

Astro: one `<script type="module">` in `<head>` per page. pletivo: **544 in
`<body>`**, at each component's inline position, up to 35 identical tags on a
single page. ES-module URL dedup means they execute once, so this is markup and
load-order noise rather than broken behaviour — but it is 2.6× the tags.

Since then: `build` keeps the first tag per script on each written page and drops
the rest, inline or linked, so a page runs each script once, as in Astro. It
dedupes the written HTML, not render calls, because pletivo also renders slot
fallbacks and children it may discard; a claim at render time would lose the
script. One deliberate divergence follows: a slot probed with
`Astro.slots.render()`, discarded, and rendered again by `<slot />` keeps its
script, where Astro emits none. `dev` and the Workers host do not dedupe, so a
component used twice still gives two identical *linked* tags there; the module
runs once, so that is noise, not double execution.

The "one script in `<head>`" above is the Astro 4.16 baseline of this site;
Astro 5 renders processed scripts at the component's position, as pletivo does,
so placement is no longer a gap.

`build` inlines a processed script as Astro does: its bundle imports nothing and
passes `vite.build.assetsInlineLimit` (default 4096 B; `0` keeps every script
linked, the function form is honoured). Bundles that mention `import.meta` or
hold `</script` or `<!--` stay linked. pletivo-native projects (no Astro config)
always use 4096 B and have no switch. `dev` always links, as `astro dev` does,
so the build-only behaviours are: `import.meta` resolution, CSP (`script-src
'self'` blocks inline scripts unless the limit is `0`; pletivo emits no CSP
hashes), and the public-asset rewrite of item 2.

## Cosmetic classes (listed so nobody re-investigates them)

Tailwind output keeps native CSS nesting (`&:hover`) where Astro flattens it —
fine on evergreen browsers, drops Safari < 16.5 / Chrome < 112. Scope classes are
`class="astro-XXXX"` + `:where()` vs Astro's `data-astro-cid-*`. Inline `<style>`
vs external route CSS. Different asset-hash naming. Source whitespace and
attribute order preserved. `astro-icon` sprite `<symbol>` attaches to the first
use rather than the last (sprite sets identical per page, 211/211).

**After normalising every class above, visible text is identical on 190/211
pages.** The remaining 21 are exactly items 4–6.

## What worked, including things worth not taking for granted

The whole Content Layer API (`glob()` loader, `render()`, `image()` in schemas),
all 9 `getStaticPaths` pages, both endpoint routes (`eshop.json` byte-identical
but for its `generated_at` stamp — the project's own `scripts/verify-build.ts`
passes against pletivo's `dist`), Tailwind 4 through `@tailwindcss/vite`,
`astro-icon`, `@astrojs/sitemap` including its `filter` callback, the custom
rehype plugin (it runs), `.md` collections, `set:html`, named slots, `@/*`
tsconfig paths, and `_redirects` / `_headers` passthrough byte-identical.

## Verdict

A good dogfood target, not yet a migration target. Item 1 is the blocker and is
not about Astro compatibility at all.

Timings are not comparable and should not be quoted: pletivo emitted 1.85× fewer
image tasks (2383 vs 4408) because of item 3.
