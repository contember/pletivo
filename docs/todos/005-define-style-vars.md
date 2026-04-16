# defineStyleVars

**Priority:** A-tier
**Status:** No-op stub
**Area:** CSS / Rendering

## Problem

`defineStyleVars` in `.astro` files allows setting CSS custom properties from component frontmatter/props. The Astro compiler emits calls to `$$defineStyleVars()` but Pletivo's shim returns nothing.

## Current State

- `astro-shim.ts`: `defineStyleVars()` is a no-op

## Expected Behavior

`defineStyleVars` should inject a `style` attribute with CSS custom properties on the scoped element:

```astro
---
const { color } = Astro.props;
---
<div class="box">...</div>
<style define:vars={{ color }}>
  .box { background: var(--color); }
</style>
```

Should produce: `<div class="box" style="--color: red">...</div>`

## Files

- `packages/pletivo/src/runtime/astro-shim.ts` — `defineStyleVars` stub
