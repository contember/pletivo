# injectScript — Missing Stages

**Priority:** B-tier
**Status:** Done (commit 407851d)
**Area:** Integrations

## Problem

`injectScript(stage, code)` supports `"page"` and `"head-inline"` stages, but `"page-ssr"` and `"before-hydration"` are logged as unsupported and ignored. Some integrations use these stages.

## Current State

- `"page"` — works: every page script is bundled into one module (packages and Vite virtual modules resolved), written inline as `<script type="module">` by build, dev and `prepare`
- `"head-inline"` — works, inline `<script>`
- `"page-ssr"` — logged as unsupported, ignored
- `"before-hydration"` — logged as unsupported, ignored

### `"page"`: where pletivo differs from Astro

`astro-host/page-scripts.ts` bundles the page scripts. Packages resolve from the
project with browser conditions. A Vite virtual module resolves through the
collected plugins, and so do its own imports, including Vite's root-relative
`/src/...` ids. A `</script` in the bundle is escaped to `<\/script`, which reads the
same everywhere except in a tagged template's raw text: `String.raw` sees the
backslash. A bundle that needs a chunk, a stylesheet or an asset fails the build, and
so does one holding both `<!--` and `<script`.

The build runs `astro:build:start` and `astro:build:setup` before it bundles, so a
Vite plugin added in `astro:build:setup` can serve a page script. Dev and `pletivo
prepare` run neither hook; there such a plugin must be added in `astro:config:setup`.

- **Inline on every page, not one cached file.** Astro links a single
  `/_astro/page.*.js` from every page. pletivo writes the module inline, so each page
  pays its full size. For `@astrojs/alpinejs` that is 47,471 B per page (16,746 B
  gzip), where Astro's linked file is 45,324 B (16,355 B gzip) and is fetched once.
  The Workers host has no output directory for a shared file, and inlining keeps both
  hosts byte-identical.
- **One module per script, not one shared scope.** Astro concatenates the page
  scripts into one module (`vite-plugin-scripts`). Their top-level names share one
  scope there: a name declared twice is a build error, and every script's imports run
  before any script body. pletivo makes each script its own module, imported in
  injection order. Each keeps its own scope, so a repeated name is fine, and each
  script's imports run just before that script's body.

## Expected Behavior

- `"page-ssr"` — script runs as a module during SSR/build (useful for polyfills or global state setup during rendering)
- `"before-hydration"` — script runs before any island hydration starts (useful for framework setup, global stores)

For SSG, `"page-ssr"` executes at build time. `"before-hydration"` should be injected as an inline script before the hydration runtime.

## Files

- `packages/pletivo/src/astro-host/runner.ts` — `injectScript` implementation
