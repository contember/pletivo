# 012 — Endpoint routes in `src/pages`

**Status: Done** (static endpoints)

## Problem

Astro lets a page file carry its own extension and export `GET()` instead of a
component: `src/pages/robots.txt.ts` → `/robots.txt`, `src/pages/rss.xml.ts` →
`/rss.xml`. Pletivo scanned those files as routes, found no default export, and
skipped them:

```
Skipping robots.txt.ts: no default export function
Skipping eshop.json.ts: no default export function
```

**The build still exited 0.** A project relying on such a route — a robots.txt,
a sitemap, a JSON catalog an e-shop prices against — produced a green deploy
with those files silently missing. That is the worst possible failure shape: no
error, no non-zero exit, just absent output discovered in production.

Only integration-injected routes (`injectRoute()`) supported `GET()`, and they
had to live outside `src/pages/`.

## What was implemented

- **`router.ts`** — `Route.isEndpoint`. A `.ts`/`.js` route whose basename still
  carries an extension is an endpoint. `routeToOutputPath()` emits that path
  verbatim instead of appending `index.html`. Template formats (`.astro`,
  `.md`, `.mdx`) are never endpoints — they always render HTML.
- **`build.ts`** — endpoint routes import the module, call `GET()` through the
  shared `renderEndpoint()`/`makeEndpointContext()` helpers, and write the body.
- **`dev.ts`** — `serveEndpoint()` returns the handler's own `Response`
  untouched, so status and `Content-Type` come from user code.

### Bug fixed along the way

Injected endpoints were pushed into `results` *and* written directly, so they
were emitted twice — the second time through `writeHtml()`, which rewrites
public-asset references and injects CSS. Since `writeHtml` falls back to
prepending the `<style>` block when the output has no `</head>`, any injected
JSON/XML endpoint could be corrupted into unparseable output as soon as the
project had page-scoped CSS. Endpoint results now carry `raw: true` and bypass
the HTML pipeline entirely.

## Not supported

**Dynamic endpoints** (`[slug].json.ts`). The filename would have to be parsed
as a parameter plus a trailing extension, which affects `matchRoute` and
`routeToOutputPath` both. These are rare; static endpoints cover robots/RSS/
sitemap/catalog. The build now warns explicitly rather than emitting nothing:

```
Skipping [slug].json.ts: dynamic endpoint routes are not supported (only static ones like rss.xml.ts)
```

**i18n interaction** is unexplored — `tests/astro-e2e/manifest.ts` still removes
`src/pages/test.json.js` from the i18n fixtures. Endpoints are not expanded per
locale, which is probably right, but it is untested.

## Tests

- `tests/unit/router.test.ts` — parsing, output paths, URL matching, negative cases
- `tests/integration/endpoint-routes.test.ts` + `tests/fixture-endpoint-routes/`
  — real build; asserts JSON parses, no `<style>` leaked in, XML keeps `<?xml`
  on the first byte, and no `index.html` directory is created
