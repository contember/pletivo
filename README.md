# Pavouk

Bun-powered static site generator that runs Astro projects ~2x faster.

Drop-in compatible with `.astro` pages, content collections, scoped CSS, Tailwind v4, and the Astro integration ecosystem. Also supports native JSX/TSX pages with Preact islands.

[![CI](https://github.com/contember/pavouk/actions/workflows/ci.yml/badge.svg)](https://github.com/contember/pavouk/actions/workflows/ci.yml)

## Quick start

```bash
# In an existing Astro project
bunx pavouk build        # Static build → dist/
bunx pavouk dev           # Dev server with HMR
```

Or add it to `package.json`:

```json
{
  "scripts": {
    "dev": "pavouk dev",
    "build": "pavouk build"
  },
  "dependencies": {
    "pavouk": "*",
    "@astrojs/compiler": "^3"
  }
}
```

## What works

Pavouk compiles `.astro` files using `@astrojs/compiler` and renders them with its own Bun-native runtime. Tested against Astro's own test suite:

- `.astro` pages and components (props, slots, `Astro.slots.render()`, scoped CSS, `class:list`)
- Content collections with Zod schemas, `getCollection()`, `getEntry()`, `reference()`
- `getStaticPaths()` for dynamic routes
- `.md` pages in `src/pages/`
- `<script>` and `<script is:inline>` tags
- Tailwind CSS v4 pipeline
- Astro integrations via Vite host shim
- Dev server with HMR (CSS hot swap + morphdom DOM patching)
- Public asset hashing and sitemap generation

## Performance

Benchmarked on a real production site (113 pages, 12 content collections, MDX, Tailwind):

| | Pavouk | Astro | Speedup |
|---|---|---|---|
| Build time | **3.5s** | 6.7s | 1.9x |
| Output | 486 files, 13 MB | 486 files, 13 MB | identical |
| HTML diff | — | — | 113/113 pages match |

## Project structure

Bun workspace monorepo:

```
packages/
  pavouk/             Core SSG engine (CLI, router, JSX runtime, islands,
                      content collections, CSS pipeline, dev server, astro shim)
  astro-jsx-pages/    Babel+Vite plugin enabling TSX pages inside Astro
  pavouk-astro/       Astro integration wrapping astro-jsx-pages

examples/
  basic/              Pavouk-native example (JSX pages, islands, collections)
  basic-astro/        Pure Astro baseline (for benchmarking)
  basic-astro-native/ Pavouk running native .astro files
```

## Configuration

Optional `pavouk.config.ts`:

```typescript
import { defineConfig } from "pavouk";

export default defineConfig({
  outDir: "dist",
  port: 3000,
  base: "/",
  srcDir: "src",
  publicDir: "public",
});
```

## Tests

```bash
bun install
bun test tests/unit tests/integration tests/e2e   # Unit + integration + e2e

# Astro compatibility suite (clones Astro repo, runs their tests against pavouk)
cd tests/astro-e2e
bun run setup.ts
npm run test:integration    # node:test + cheerio (fast)
npm run test:e2e            # Playwright browser tests
```

## License

MIT
