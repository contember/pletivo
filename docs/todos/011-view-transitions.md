# View Transitions

**Priority:** C-tier
**Status:** No-op stubs
**Area:** Navigation / Client-side

## Problem

View Transitions / `<ClientRouter>` provide SPA-like page transitions without a full client-side router. `renderTransition()` and `createTransitionScope()` are no-op stubs.

## Current State

- `astro-shim.ts`: `renderTransition()` and `createTransitionScope()` return empty strings
- `<ClientRouter>` component compiles but transition attributes are not emitted
- No `astro:transitions` virtual module

## Expected Behavior

If implemented:
- `transition:name` and `transition:animate` directives produce `view-transition-name` CSS
- `<ClientRouter>` injects client-side navigation script
- `astro:transitions` module exports `slide`, `fade`, etc.

## Notes

Low priority for SSG. Astro itself is moving away from the original `<ViewTransitions>` toward `<ClientRouter>`. For SSG sites, client-side navigation libraries (htmx, swup, barba.js) can fill this role. Consider leaving this as explicitly unsupported.

## Files

- `packages/pletivo/src/runtime/astro-shim.ts` — transition stubs
