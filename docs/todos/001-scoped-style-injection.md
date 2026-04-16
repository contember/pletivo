# Scoped Style Injection

**Priority:** S-tier
**Status:** Done

## What was fixed

1. **Unscoped CSS rules were silently dropped.** The Astro compiler doesn't scope element selectors like `body`, `html`, `*` — they're emitted as-is even though the component's elements receive scope class attributes. `getScopedCssForPage()` was matching by finding `astro-XXXXX` inside the CSS text, which missed these rules entirely.

   **Fix:** `scopedCssMap` now stores the compiler's `result.scope` hash per file. `getScopedCssForPage()` matches by scope class presence in the HTML (`astro-{scope}` in element attributes), then includes ALL CSS entries for that component — including unscoped rules.

2. **Pages without `</head>` lost all scoped CSS.** The injection code only handled the `html.includes("</head>")` case with no fallback.

   **Fix:** Falls back to `</body>`, then prepends to the HTML.

3. **No test coverage.** Added `tests/integration/scoped-styles.test.ts` with fixture `.astro` files covering: layout + child component scoped styles, per-page CSS isolation (no cross-page leaks), standalone page styles, and the no-`<head>` edge case.

## Architecture note

`renderHead()` in the shim is an intentional no-op. Scoped CSS is injected post-render by `build.ts` and `dev.ts` via `getScopedCssForPage()`, which extracts scope classes from the fully rendered HTML. This approach provides per-page CSS tree-shaking that can't be done inline during render (the full set of rendered components isn't known until the template finishes evaluating).

## Files changed

- `packages/pletivo/src/astro-plugin.ts` — `scopedCssMap` stores scope hash per entry, `getScopedCssForPage()` matches by scope class
- `packages/pletivo/src/build.ts` — fallback injection for pages without `</head>`
- `packages/pletivo/src/runtime/astro-shim.ts` — documented `renderHead()` no-op rationale
- `tests/integration/scoped-styles.test.ts` — new test file
- `tests/fixture-astro-styles/` — new test fixture
