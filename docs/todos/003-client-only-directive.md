# client:only Directive

**Priority:** A-tier
**Status:** Not implemented
**Area:** Islands / Hydration

## Problem

`client:only="preact"` (or react/svelte/etc.) tells Astro to skip SSR for a component and only render it client-side. This is needed for components that depend on browser APIs (`window`, `document`, `canvas`, etc.) at render time — charts, maps, rich editors, WebGL.

## Current State

Unclear whether `client:only` works. The island system always SSR-renders the component and wraps it in `<pletivo-island>`. If the component accesses browser APIs during SSR, it will crash.

## Expected Behavior

- `client:only` skips SSR entirely — renders a placeholder `<pletivo-island>` with no inner HTML
- Client-side hydration script loads and renders the component from scratch
- The `client:only` value specifies which renderer to use (for Pletivo this is always preact/JSX)

## Files

- `packages/pletivo/src/runtime/island.ts` — island rendering
- `packages/pletivo/src/runtime/hydration.ts` — client-side hydration
