# CSS Modules Support

**Priority:** B-tier
**Status:** Done (commit b6f789d)
**Area:** CSS / Styling

## Problem

CSS Modules (`.module.css`) provide locally-scoped class names via import. While Tailwind is dominant, some projects (especially those migrating from Next.js or CRA) rely on CSS Modules.

## Current State

- CSS pipeline (`css.ts`) handles global CSS and Tailwind
- No `.module.css` file handling or class name mapping

## Expected Behavior

```tsx
import styles from './Card.module.css';
// styles.card -> "Card_card_x7f2a"

<div class={styles.card}>...</div>
```

- Import `.module.css` returns an object mapping local names to generated unique names
- Generated class names are included in the CSS output
- Works in both `.astro` and `.tsx` files

## Files

- `packages/pletivo/src/css.ts` — CSS pipeline
