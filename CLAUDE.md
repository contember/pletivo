# Pavouk

Bun-powered static site generator with JSX/TSX pages, file-based routing, content collections (Zod), and Preact islands. Also runs inside Astro as an integration.

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

Bun workspace monorepo:

- **`packages/pavouk`** — Core SSG engine: CLI, router, JSX runtime (SSR), island hydration, content collections, CSS pipeline (Tailwind v4), dev server with HMR, astro-host shim.
- **`packages/astro-jsx-pages`** — Babel+Vite plugin enabling TSX pages inside Astro. Built with tsc.
- **`packages/pavouk-astro`** — Astro integration wrapping `astro-jsx-pages`.
- **`examples/`** — `basic` (pavouk-native), `basic-astro`, `basic-astro-native`.

## Critical Invariants

- Island registry tracks islands per render pass — call `resetIslandRegistry()` between page renders or islands leak across pages.
- Island props must be JSON-serializable.
