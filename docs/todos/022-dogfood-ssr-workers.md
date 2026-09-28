# 022 — Dogfood: the SSR dogfood site through the Workers host, and the backlog it produced

**Priority:** S-tier (items 1–4), A-tier (5–8)
**Status:** Open — measured; items 3 and 4 fixed, the rest are the backlog
**Area:** prepare / Workers host / router

The second dogfood site, and the first one taken through `@pletivo/workers`
rather than through a build. Companion to [018](018-dogfood-ssr-dev-server.md),
which measured the same project on the Bun **dev server**; this one asks the
question the Workers host exists for.

The project: a workspace monorepo's `packages/web` — 47 page files (27 static
`.astro`, 12 dynamic, 8 endpoints), Astro 6.3.1, `output: 'server'`, the whole
`@nuasite/*` stack, 11 content collections, 1529 content files, Tailwind 4 with
flowbite and swiper, `astro:env` secrets, and a Contember API behind four routes.

## The headline

`pletivo prepare` runs it, reports **7 diagnostics and refuses 4 specifiers**,
and every refusal stops the render at the first page that needs it. Standing
back up each refusal by hand — doing what a fixed prepare would do, in the
harness, so the *rest* of the walls could be counted — the host renders

**32 of 35 routes.** Of the 3 that do not:

- 1 is a real bug (item 5, route precedence),
- 2 are the harness guessing a slug the route's `getStaticPaths` filters out
  (`role === 'team'` / `'partner'`) — not a host failure.

The 4 routes not attempted are the Contember ones. They fail for a reason that
is the design working: the render isolate reaches nothing unless the host says
so, and the project's own guard refuses to enumerate `/kurzy/hledani` with zero
paths. `outbound: { kind: "proxy", … }` plus the three `CONTEMBER_*` values is
what they need; see `outbound.ts`.

So: **nothing about this site is beyond the Workers host.** What stands between
it and a real render is prepare's vendoring, and it fails in four distinct ways
worth separating.

## 1. Type-only imports are vendored, and one of them cannot be bundled

`requestsFrom` reads `specifierUses`, a regex (`scan.ts:79-129`), while the
vendored-source walk reads `specifiersOf`, `Bun.Transpiler.scanImports`
(`scan.ts:49`). The two disagree about TypeScript's `type` modifier:

| source | `scanImports` | the regex |
|---|---|---|
| `import type { APIRoute } from 'astro'` | elided | **queues `astro`** |
| `import { relatedContent, type RelatedContentCurrent } from '@app/lib'` | queues it | queues it, **and asks for `RelatedContentCurrent` by name** |

Measured. Both spellings are ordinary; this site has 8 of the first and 3 of the
second. The consequences:

- **`astro` is queued for vendoring** and `Bun.build` cannot bundle its Node
  entry for a browser target, so prepare reports `astro (vendor): Bundle failed`
  for a specifier nothing needs at run time.
- **`@app/lib` is refused** with "the bundle does not export
  RelatedContentCurrent" — because a type is not an export. Dropping the name
  makes it bundle, verified: 46 kB.

`specifierUses` strips a leading `type ` from an entry (`scan.ts:119`) and then
adds the name anyway. It has to drop the entry instead.

**Cheapest item on this list, and it unblocks two of the four refusals.**

## 2. prepare scans `srcDir`; the file map is the project

`readSources(root, srcDir)` (`prepare/index.ts:175`) globs `src/**` and nothing
else. The Workers host's file map is the whole project root. So a module the
pages import from *outside* `src/` is compiled by the host and its npm imports
were never vendored.

Here that is `lib/` at the package root — `lib/contember.ts` imports
`@contember/client-content` and `@contember/graphql-client`, and the isolate
answers `No such module`. 6 routes, and it also killed `/__paths` outright.

The two have to agree about what the project is.

## 3. Vite's `?raw` / `?inline` — fixed

The Bun host resolves these (`astro-plugin.ts:571`); the Workers host did not,
so `import icon from "../assets/mark.svg?raw"` reached the Loader verbatim.
**28 of 29 routes**, all on the same wall. Fixed in `compile-project.ts`.

Note the semantic divergence being preserved deliberately: Vite's `?inline` is a
data: URI and pletivo's is the text. The two hosts agreeing matters more, so
this follows the Bun host. Worth revisiting as its own decision.

## 4. Vite's `?url` — fixed

Same family, different thing: a string *and* a file somebody has to serve. Now
resolves to `_astro/<base>.<md5-8><ext>` — the name `url-asset.ts` emits, so the
markup is identical on either host — and the file rides back in
`RenderedAsset[]` next to the project stylesheet.

## 5. Route precedence is a sum; Astro's is positional

`parseRoute` accumulates one number over the segments (`router.ts:45-73`): static
`+1`, param `+10`, rest `+100`, lower wins. A sum lets a later segment outweigh
an earlier one, which is precisely what Astro's rule forbids. Measured:

| route | priority | matches `/aktualne` |
|---|---|---|
| `[topic]/index.astro` | 10 | `{topic: "aktualne"}` |
| `aktualne/[...page].astro` | 101 | `{}` |

Both match, and the sum ranks the wrong one first — so `/aktualne`, the first
page of a paginated listing, resolves to the topic route and 404s with
"getStaticPaths() returned no entry for these params".

Astro compares **segment by segment**: at the first position where two routes
differ, static beats param beats rest. At position 0 `aktualne` is static and
`[topic]` is not, and nothing later can overturn that.

The fix is a lexicographic comparator over segment kinds, in
`@pletivo/core/router`. It changes route resolution for every host that matches
a pathname — the dev server and the Workers host — so it wants its own commit
and its own tests. A build that enumerates every path instead of matching one
(`pletivo build`) is unaffected, which is why the static dogfood site's 211 routes never showed
it.

## 6. A package whose entry is a build-time integration cannot be vendored

`@nuasite/cms`' entry re-exports the Astro integration next to the runtime
helpers `content.config.ts` actually imports, so `Bun.build` follows it into
`@tailwindcss/node`, vite, esbuild and `@tailwindcss/oxide`'s native binary.
Tree-shaking does not save it — the modules are reached by import, and nothing
declares them side-effect free. Measured, both with and without the type name
from item 1.

Externalising the bare (non-`node:`) builtin names clears 3 of the 5 errors;
the two `.node` files remain, and `external: ["*.node"]` does not name them.
Pointing the bundle at the leaf module that defines the wanted names
(`src/field-types.ts`, which imports nothing) produces a working 446 kB module.

Three directions, all plausible, none obviously right:

- resolve the requested names to their defining module rather than bundling the
  package entry;
- keep bundling the entry but replace anything unresolvable in workerd with a
  stub that throws when called — the isolate never calls it, and if it does the
  error names the cause;
- resolve through the package's `exports` subpaths where it has runtime ones.

## 7. A hoisted package's `.astro` sources have no key

`@nuasite/components/Image.astro` resolves to
`<monorepo>/node_modules/@nuasite/components/src/image/index.astro`. The project
root is `packages/web`, so the relative path climbs out of it and `projectKey`
correctly returns `null` — `resolveSpecifier` drops a `..`, so such a key could
never resolve (`vendor.ts:248, 265-271`).

Correct, and it means **no workspace monorepo with hoisted dependencies can
carry a component library**. Every `.astro` from npm is this case. `vendorSpecifiers`
already takes a `pathPrefix`; what is missing is a key space inside the project
root for sources that come from outside it (`.pletivo-vendor/…` is what the
harness used, and it worked).

## 8. `Bun.build`'s errors are thrown away

`bundlePackage` catches and stores `String(error)` (`vendor.ts:315-318`). With
`Bun.build`'s default `throw: true` that is `AggregateError: Bundle failed` —
which is what the user sees, for both of the failures above. The five real
messages are on `error.errors` and one line reaches them.

Diagnostics that name the cause are the difference between item 6 taking ten
minutes and taking an afternoon.

## Smaller, still real

- **`/__paths` is all-or-nothing.** One route whose `getStaticPaths` throws stops
  the enumeration for every route — `@contember/client-content` did it first,
  `?url` second, the network guard third. A per-route result would let a preview
  index list what it can and report what it cannot.
- **Tailwind cannot follow an npm `@import`.** `global.css` opens with
  `@import "flowbite/src/themes/default"`, `@plugin "flowbite/plugin"`,
  `@source "../../node_modules/flowbite"` and `@import "swiper/css"`. prepare
  scans JS and `.astro`, never `.css`, so none of it is carried and the CSS
  pipeline reports `cannot resolve stylesheet "flowbite/src/themes/default"`.
  This blocked **every route** before anything else did. `@plugin` is a JS
  plugin, so it is the hardest of the four.
- **`astro:middleware` has no answer** and `src/middleware.ts` imports it —
  correctly diagnosed by prepare, and it means this site's middleware does not
  run at all.
- **`Astro.redirect` is a meta-refresh page**, which is right for a static build
  and wrong for a host that could send a 301. `renderPage` returns HTML and
  nothing else; an SSR host needs status and headers. Same shape of gap as
  endpoints ([018](018-dogfood-ssr-dev-server.md) items 1–2).
- **`markdown.rehypePlugins` are still not carried** — 5 live functions on this
  site, reported honestly by prepare and dropped. Also
  [018](018-dogfood-ssr-dev-server.md) item 5 and
  [020](020-workers-integration-phase.md) step 5.

## What worked, and is worth not taking for granted

`prepare` ran the whole `@nuasite/nua` integration stack — CMS, page markdown,
MDX, sitemap, checks, the project's own `contentIndex` integration writing a
real file, pagefind — and reported the one thing it could not do
(`Output type 'server' … will not work with astro-pagefind`) as the integration's
own message rather than as a crash. 11 content collections resolved from a
`contentDir` that is not `src/content`. `astro:env` with five secret fields.
`Astro.redirect`. A 4.3 MB listing page built from 1300 collection entries. And
the diagnostics list is genuinely good — six of the seven pointed at exactly the
right file, and the seventh is item 8.

## Verdict

The Workers host is not the bottleneck for this site — `prepare` is, and in four
separable ways of which item 1 is nearly free. The one host-side bug found is
item 5, and it is in shared router code rather than anything Workers-specific.
