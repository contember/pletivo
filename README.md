# Pletivo

Bun-powered static site generator that runs Astro projects ~2x faster.

Drop-in compatible with `.astro` pages, content collections, scoped CSS, Tailwind v4, and the Astro integration ecosystem. Also supports native JSX/TSX pages with Preact islands.

[![CI](https://github.com/contember/pletivo/actions/workflows/ci.yml/badge.svg)](https://github.com/contember/pletivo/actions/workflows/ci.yml)

## Quick start

```bash
# In an existing Astro project
bunx pletivo build        # Static build → dist/
bunx pletivo dev           # Dev server with HMR
```

Or add it to `package.json`:

```json
{
  "scripts": {
    "dev": "pletivo dev",
    "build": "pletivo build"
  },
  "dependencies": {
    "pletivo": "*",
    "@astrojs/compiler": "^3"
  }
}
```

## What works

Pletivo compiles `.astro` files using `@astrojs/compiler` and renders them with its own Bun-native runtime. Tested against Astro's own test suite:

- `.astro` pages and components (props, slots, `Astro.slots.render()`, scoped CSS, `<style is:global>`, `class:list`)
- Content collections with Zod schemas, `getCollection()`, `getEntry()`, `reference()`
- `getStaticPaths()` for dynamic routes
- `.md` pages in `src/pages/`
- a file or directory under `src/pages/` whose name starts with `_` is not a route, as in Astro (pletivo-native projects too)
- `<script>` and `<script is:inline>` tags
- Tailwind CSS v4 pipeline
- Astro integrations via Vite host shim
- Dev server with HMR (CSS hot swap + morphdom DOM patching)
- `public/` copied verbatim, as Astro does (pletivo-native projects: content-hashed, plus a generated `sitemap.xml`)

## Hosting

In an Astro project, only some JavaScript under `/_astro/` is named by content:

| files under `/_astro/` | named by | cache as |
|---|---|---|
| `chunk-<hash>.js` with an 8-character hash, e.g. `chunk-e677st6c.js` (code shared between islands); match `^chunk-[a-z0-9]{8}\.js$`, not `chunk-*`, which also catches an island named `chunk-…` | content | `immutable` is safe |
| non-JS files (images, `?url` imports) | content | `immutable` is safe |
| every other `*.js`: island entries (`<Name>.<hash>.js`, `client.<hash>.js`, `before-hydration.<hash>.js`) and hoisted scripts (`hoisted-<hash>.js`) | the component path, the renderer name or the inline script source, not the bundled code | `Cache-Control: no-cache`, or a short `max-age` |

Island entries and hoisted scripts keep their URL when the code they bundle
changes: a component, one of its imports, or a framework upgrade. A browser
holding the old file runs the old code, or fails to hydrate the island if the
chunks it imports are gone. Purging a CDN on deploy does not help here: it cannot
evict a copy the browser already holds as `immutable`. A CDN may still keep these
files longer through an edge TTL (`s-maxage`), if it is purged on every deploy.
A `?url`-imported `.js` file is content-hashed, but its name looks like an
island entry's, so a header rule matching `*.js` treats it the same, at the cost
of a revalidation. See
[`docs/todos/025`](docs/todos/025-island-content-hashed-urls.md).

## Performance

Benchmarked on a real production site (113 pages, 12 content collections, MDX, Tailwind):

| | Pletivo | Astro | Speedup |
|---|---|---|---|
| Build time | **3.5s** | 6.7s | 1.9x |
| Output | 486 files, 13 MB | 486 files, 13 MB | identical |
| HTML diff | — | — | 113/113 pages match |

## Project structure

Bun workspace monorepo:

```
packages/
  pletivo/             Core SSG engine (CLI, router, JSX runtime, islands,
                      content collections, CSS pipeline, dev server, astro shim)
  runtime/            Render-time runtime (JSX SSR, astro shim, islands)
  core/               Host-agnostic engine (router, content, markdown, images)
  workers/            Cloudflare Worker host (@pletivo/workers)
  astro-jsx-pages/    Babel+Vite plugin enabling TSX pages inside Astro

examples/
  basic/              Pletivo-native example (JSX pages, islands, collections)
  basic-astro/        Pure Astro baseline (for benchmarking)
  basic-astro-native/ Pletivo running native .astro files
```

## Cloudflare Workers

`@pletivo/workers` renders a project inside a Cloudflare Worker, from source files
held in memory or in a Durable Object, with no build step. It ships TypeScript
source that your Worker's bundler compiles. See
[`packages/workers/README.md`](https://github.com/contember/pletivo/blob/main/packages/workers/README.md) for the wrangler and
TypeScript setup.

## Configuration

Optional `pletivo.config.ts`:

```typescript
import { defineConfig } from "pletivo";

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

# Astro compatibility suite (clones Astro repo, runs their tests against pletivo)
cd tests/astro-e2e
bun run setup.ts
npm run test:integration    # node:test + cheerio (fast)
npm run test:e2e            # Playwright browser tests
```

## License

MIT
