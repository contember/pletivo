# injectScript — Missing Stages

**Priority:** B-tier
**Status:** Partially implemented
**Area:** Integrations

## Problem

`injectScript(stage, code)` supports `"page"` and `"head-inline"` stages, but `"page-ssr"` and `"before-hydration"` are logged as unsupported and ignored. Some integrations use these stages.

## Current State

- `"page"` — works, wrapped in `<script type="module">`
- `"head-inline"` — works, inline `<script>`
- `"page-ssr"` — logged as unsupported, ignored
- `"before-hydration"` — logged as unsupported, ignored

## Expected Behavior

- `"page-ssr"` — script runs as a module during SSR/build (useful for polyfills or global state setup during rendering)
- `"before-hydration"` — script runs before any island hydration starts (useful for framework setup, global stores)

For SSG, `"page-ssr"` executes at build time. `"before-hydration"` should be injected as an inline script before the hydration runtime.

## Files

- `packages/pletivo/src/astro-host/runner.ts` — `injectScript` implementation
