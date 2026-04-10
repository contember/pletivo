# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Pavouk is a static site generator powered by Bun. It uses JSX/TSX for pages, file-based routing, content collections with Zod validation, and an islands architecture (Preact) for client-side interactivity. It can also run inside Astro as an integration.

## Commands

```bash
bun install                              # Install dependencies (Bun workspaces)

# Dev & build (run from an example project)
bun run --cwd examples/basic dev         # Dev server with HMR (port 3000)
bun run --cwd examples/basic build       # Static build → dist/

# Tests
bun test                                 # All tests
bun test tests/unit/router.test.ts       # Single test file
bun test tests/unit/                     # Test directory

# Benchmark (pavouk vs native Astro build)
scripts/benchmark.sh                     # 5 runs (default)
RUNS=10 scripts/benchmark.sh
ONLY=pavouk scripts/benchmark.sh
```

`@pavouk/astro-jsx-pages` uses Node (not Bun) and has its own scripts:
```bash
cd packages/astro-jsx-pages
bun run build     # tsc → dist/
bun run test      # node --test
```

No linter or formatter is configured.

## Project Structure

Bun workspace monorepo with three packages:

- **`packages/pavouk`** — Core SSG engine: CLI (`pavouk build`/`pavouk dev`), router, JSX runtime (SSR), island hydration, content collections, CSS pipeline (Tailwind v4), dev server with HMR, and an astro-host shim for running Astro integrations.
- **`packages/astro-jsx-pages`** — Babel+Vite plugin enabling TSX pages inside Astro. Transforms JSX to Astro render calls, detects islands, injects hydration scripts. Built with tsc (published as JS).
- **`packages/pavouk-astro`** — Astro integration wrapping `astro-jsx-pages`. Transforms `client="load"` → `client:load`, aliases `pavouk/hooks` → `preact/hooks`, shims content collection API.

Three example projects: `examples/basic` (pavouk-native), `examples/basic-astro`, `examples/basic-astro-native`.

## Architecture

### Rendering pipeline

Pages are JSX/TSX files in `src/pages/`. The custom JSX runtime (`packages/pavouk/src/runtime/jsx-runtime.ts`) renders to HTML strings server-side, supporting async components. Islands (components in `src/islands/` with a `client` prop) are wrapped in `<pavouk-island>` markers with serialized props for client-side Preact hydration.

### Island system

- Island registry (`src/runtime/island.ts`) tracks which islands are used during each render pass — must be reset between page renders via `resetIslandRegistry()`.
- Props must be JSON-serializable. Hydration strategies: `load`, `idle`, `visible`, or media query strings.
- Build step bundles each used island into a separate JS file.

### Routing

File-based router (`src/router.ts`): `[slug].tsx` for params, `[...path].tsx` for catch-all. Priority: static segments > named params > catch-all. Dynamic routes export `getStaticPaths()` returning `{ params, props }[]`.

### Content collections

Defined in `src/content.config.ts` via `defineCollection({ loader: glob({ base: "..." }), schema: z.object({...}) })`. Accessed with `getCollection()`/`getEntry()`. Markdown frontmatter is validated against the Zod schema.

### Dev server

WebSocket-based HMR (`src/dev.ts`). CSS changes are hot-swapped; page/component changes trigger re-render with morphdom patching. Islands are bundled on-demand as virtual modules.

### Astro host

`src/astro-host/` provides a pseudo-Astro environment so that Astro integrations can run within pavouk. It bridges pavouk's page data into Astro's request context and compiles `.astro` files via the `@astrojs/compiler`.
