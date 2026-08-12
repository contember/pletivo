# Pletivo — Astro Compatibility TODOs

SSG-relevant gaps in Astro API surface support, ordered by priority.

## S-tier — Core, must work

- [001 — Scoped Style Injection](001-scoped-style-injection.md) — `renderHead()` is no-op, scoped `<style>` never reaches the page
- [019 — CSS chunking](019-css-chunking.md) — **open**; the 23.4 MB bundle accounted to the byte, plus the spec Astro follows and pletivo needs
- [020 — Integrations in the Workers host](020-workers-integration-phase.md) — **design**; npm resolution turns out to be the first blocker, not integrations
- [017 — Dogfood: a real production Astro site](017-dogfood-static-site.md) — **open**; it built with zero edits, but a 23.4 MB CSS bundle, hashed `public/` assets and dropped `srcset` would break the live site
- [018 — Dogfood: an SSR site on the dev server](018-dogfood-ssr-dev-server.md) — **open**; serves the site (better than `astro dev` here), but 7 of 8 endpoints 404 and POST handlers are unsupported everywhere
- [022 — Dogfood: the same SSR site through the Workers host](022-dogfood-ssr-workers.md) — **open**; 32 of 35 routes render once prepare's four refusals are stood back up, and prepare is the bottleneck, not the host
- [023 — The live workspace](023-live-workspace-architecture.md) — **in progress**; a project served out of the Durable Object that owns its files, with the compile still unpruned and the CSS still project-wide
- [013 — SSR hooks stub leaks into island bundles](013-preact-hooks-ssr-stub-leak.md) — done; every hydrated island shipped no-op hooks and was inert, and pre-fix benchmark numbers are void
- [014 — Hoisted `.astro` CSS emission order](014-astro-css-cascade-order.md) — done; cascade order was nondeterministic, and the fix changes rendered output

## A-tier — Important for real projects

- [016 — Workers host divergences](016-workers-host-divergences.md) — where `@pletivo/workers` can disagree with the Bun host, measured
- [021 — CMS source mapping](021-cms-source-mapping.md) — **design**; the mapping is one compiler flag pletivo never passes, and it works in all three hosts
- [002 — Image Optimization](002-image-optimization.md) — `<Image>`, `<Picture>`, `getImage()` are stubbed
- [003 — client:only Directive](003-client-only-directive.md) — components needing browser APIs at render crash
- [005 — defineStyleVars](005-define-style-vars.md) — dynamic CSS custom properties from frontmatter/props

## B-tier — Unlocks integrations and specific use-cases

- [004 — injectRoute()](004-inject-route.md) — sitemap, RSS, robots.txt integrations broken
- [012 — Endpoint routes](012-endpoint-routes.md) — `src/pages/robots.txt.ts` was skipped silently; done for static endpoints
- [006 — Content Layer Custom Loaders](006-content-layer-custom-loaders.md) — CMS integrations need this
- [007 — astro:env Virtual Module](007-astro-env-module.md) — type-safe env variables
- [008 — CSS Modules](008-css-modules.md) — `.module.css` imports
- [009 — injectScript Stages](009-inject-script-stages.md) — `page-ssr` and `before-hydration` stages
- [010 — YAML Parser Limitations](010-yaml-parser-limitations.md) — anchors, multiline, flow syntax

## C-tier — Low priority / consider skipping

- [011 — View Transitions](011-view-transitions.md) — SPA-like navigation, better solved by dedicated libs
- [015 — Router param type hole](015-router-param-type-hole.md) — a missing param throws from `path.join` with a message that names nothing useful
