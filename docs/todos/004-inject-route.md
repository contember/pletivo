# injectRoute() Support

**Priority:** B-tier
**Status:** No-op
**Area:** Integrations / Routing

## Problem

`injectRoute()` in `astro:config:setup` hook is currently a no-op with a log message. This breaks popular integrations that generate pages at build time:
- `@astrojs/sitemap` — generates `/sitemap-index.xml` and `/sitemap-*.xml`
- `@astrojs/rss` — generates RSS feed endpoints
- Custom integrations that add `/robots.txt`, `/manifest.json`, etc.

## Current State

- `astro-host/runner.ts`: `injectRoute()` logs "injectRoute not supported" and returns

## Expected Behavior

- Integration calls `injectRoute({ pattern: '/sitemap.xml', entrypoint: './my-integration/sitemap.ts' })`
- Pletivo adds this route to the router
- During build, the entrypoint is loaded and its `GET()` handler (or default export) is called
- Output is written to the corresponding file in `dist/`

## Notes

For SSG, only `prerender: true` (static) injected routes need to work. API endpoints (`prerender: false`) can be rejected.

## Files

- `packages/pletivo/src/astro-host/runner.ts` — hook implementation
- `packages/pletivo/src/router.ts` — route registration
