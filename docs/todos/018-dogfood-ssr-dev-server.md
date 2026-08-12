# 018 — Dogfood: an SSR site on pletivo's dev server

**Priority:** S-tier (items 1–3), A-tier (4–6)
**Status:** Open — findings only, nothing fixed
**Area:** Endpoints / dev server / adapters

The site: a monorepo's `packages/web` — 72 `.astro`, 32 `.ts`, Astro 6.3.1,
`output: 'server'` with `@astrojs/cloudflare`, the whole `@nuasite/*` stack (nua,
cms, components, agent-summary), pagefind, 23 files with `prerender = false`, 8
endpoint routes, 10 `getStaticPaths`, 19 touching collections, 1 `client:`
directive. It already carries `pletivo` as a devDependency and a `dev:pletivo`
script, so it was built to be dogfooded.

Unlike [017](017-dogfood-static-site.md), a static build is the wrong question here.
The site is SSR; the meaningful comparison is `pletivo dev` against `astro dev`.

**It serves the site with zero edits.** Boots, runs every integration, renders
all 26 static pages plus the dynamic and collection routes.

**And on this project it beats the reference:** content collections render under
pletivo and are *broken* under `astro dev`, which fails with
`Stripping types is currently unsupported … @nuasite/cms-core/src/index.ts` →
`Content config not loaded`, taking every article, podcast and team route with
it. The project's own CLAUDE.md already tells people to use pletivo for this
reason.

## 1. Extensionless `.ts` endpoints are not treated as endpoints

`packages/core/src/router.ts:52`:

```ts
const isEndpoint = isScript && basename.includes(".");
```

`api/healthz.ts` → basename `healthz`, no inner dot → parsed as a *page*, finds
no default export, 404s. `api/sitemap-kurzy.xml.ts` works only because of the
`.xml`.

This is faithful to Astro's **static** convention (`robots.txt.ts` → `/robots.txt`)
and wrong for SSR, where any `.ts` under `pages/` is an endpoint. 7 of this
site's 8 endpoints are extensionless. No workaround short of renaming routes.

## 2. Endpoints are GET-only, everywhere

`dev.ts:589 serveEndpoint` returns null unless `mod.GET` is a function, and
`build.ts:744` does the same. There is no support for `POST`/`PUT`/`DELETE`
handlers anywhere in pletivo.

6 of the 8 routes here export only `POST`. Every form on the site — order,
contact, newsletter, discount, ARES lookup, course interest — is dead under
`pletivo dev`.

## 3. `public/` hashing breaks CSS `url()` references

`pletivo build` content-hashes files copied from `public/` and rewrites HTML
references consistently — but **not `url()` references inside CSS**. All 15
CSS-referenced public assets 404, including both custom webfonts.

**This is the same root cause as [017](017-dogfood-static-site.md) item 2**, where
absolute `og:image` URLs built in user code kept pointing at unhashed names (404
on 48 pages). Two unrelated projects, one decision: Astro copies `public/`
verbatim and cannot produce this class of breakage at all.

Hashing `public/` is a pletivo choice, and it is in conflict with every reference
that pletivo does not itself rewrite. That is the item to reconsider first.

## 4. The adapter is silently dropped

`config-loader.ts` reads only `userConfig.integrations`, so `@astrojs/cloudflare`'s
`astro:config:setup` never runs — astro logs its image-service and KV-session
setup, pletivo logs nothing. No error, no warning.

## 5. `markdown.rehypePlugins` never run

A markdown `![](cdn…)` renders as a bare `<img src alt="">`: no `<figure>`, no
CDN `srcset`. Related to [017](017-dogfood-static-site.md) item 4, which is the
narrower "plugins run but get no frontmatter" case.

## 6. `trailingSlash: 'never'` is ignored

`/kontakty/` returns 200 under pletivo, 404 under astro.

## 7. `data-astro-source-file` is absent

125 occurrences in astro's output, 0 in pletivo's (`data-cms-component-id`
likewise, 4 vs 0). The nua integration's own comments say the CMS maps elements
back to source through these, so **visual editing likely degrades**.
`data-cms-id` is present in both.

## Performance

Small pages are *faster* than astro (`/newsletter` ~0.11 s vs ~0.25 s). One
outlier: `/aktualne-z-nezisku`, a ~1000-article topic index, takes ~125 s and
4.7 MB. No astro baseline exists for it, so this is a number to investigate, not
a comparison.

## Output comparison, 14 routes

2 byte-identical (`robots.txt`, `sitemap-kurzy.xml`). The other 12 differ in four
classes: astro compresses HTML and pletivo does not; scope styling is an
`astro-<hash>` class vs astro's `data-astro-cid-*` attributes; `<link
href="/__styles.css">` vs inline `<style>` + HMR scripts; and content present
under pletivo but absent under astro (the collections failure above).

After normalising the first three, `/newsletter`, `/hledat` and `/kurzy` are
textually identical. Every remaining divergence is pletivo rendering *more*.

One divergence in the other direction: `<Image>` from `@nuasite/components`
emits full `/cdn-cgi/image/…` transform URLs with `srcset` under pletivo, and a
bare CDN `src` under `astro dev`. pletivo's looks like the production form, but
that was not confirmed against a real build.

## What else worked

`astro:config:setup` survives the whole nua stack (31 CMS components, 16
collections, llm-enhancements, sitemap, checks, pagefind, agent-summary, and the
project's own `contentIndex` integration). SSR reached the live Contember API, so
`astro:env` secrets resolve. `Astro.redirect` (301), `getStaticPaths` pagination,
and HMR on both `.astro` pages and `content/*.md` all work.

## Verdict

The dev-server story is much stronger than the build story. What stops this site
being served fully is not rendering — it is endpoints (items 1 and 2), which are
a small, well-defined piece of work.
