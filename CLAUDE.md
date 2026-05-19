# Pletivo

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

# Benchmark (pletivo vs native Astro build)
scripts/benchmark.sh                     # 5 runs (default)
RUNS=10 scripts/benchmark.sh
ONLY=pletivo scripts/benchmark.sh
```

`@pletivo/astro-jsx-pages` uses Node (not Bun) and has its own scripts:
```bash
cd packages/astro-jsx-pages
bun run build     # tsc → dist/
bun run test      # node --test
```

No linter or formatter is configured.

## Project Structure

Bun workspace monorepo:

- **`packages/pletivo`** — Core SSG engine: CLI, router, JSX runtime (SSR), island hydration, content collections, CSS pipeline (Tailwind v4), dev server with HMR, astro-host shim.
- **`packages/astro-jsx-pages`** — Babel+Vite plugin enabling TSX pages inside Astro. Built with tsc.
- **`examples/`** — `basic` (pletivo-native), `basic-astro`, `basic-astro-native`.

## Release

Only `pletivo` is published to npm. Release is triggered by pushing a `v*` tag — the CI workflow (`.github/workflows/release.yml`) runs tests and publishes automatically via npm OIDC.

```bash
# 1. Check existing tags to determine the next version
git tag -l 'v*' --sort=-v:refname | head -5

# 2. Push all commits to main
git push origin main

# 3. Create and push the tag (triggers the release workflow)
git tag v<version> && git push origin v<version>

# 4. Watch the pipeline
gh run watch $(gh run list --workflow=release.yml --limit=1 --json databaseId -q '.[0].databaseId') --exit-status
```

## Critical Invariants

- Island registry tracks islands per render pass — call `resetIslandRegistry()` between page renders or islands leak across pages.
- Island props must be JSON-serializable.

## Incremental build — dep tracking limits

`build` is incremental by default (cache lives in `node_modules/.pletivo/cache/`). Two layers feed the dep tracker:

1. **Static ESM graph** (`incremental/import-graph.ts`) — parses page source with Bun's transpiler + `@astrojs/compiler` for `.astro` + `@mdx-js/mdx` for `.mdx`. Catches any module reachable through a static `import` / `import()`.
2. **Runtime capture** (`incremental/dep-tracker.ts`) — AsyncLocalStorage-scoped `recordRuntimeDep(path)` calls fired from `getCollection`, `probeAndRegisterImage`, and the `glob()` loader.

**What is NOT tracked (known limitation):** direct `Bun.file()` / `fs.readFile()` / `import()` calls in user components that read an arbitrary data file. There is no general-purpose way to intercept these without monkey-patching globals. Workarounds:

- Route the read through a content collection (`getCollection` is tracked).
- Use static ESM `import` for JSON / data modules (`import data from "./data.json"` is in the static graph).
- For one-off external data changes, run `pletivo build --no-cache` or `--clean`.

Use `--clean` after upgrading pletivo or after any environment change you suspect the cache isn't catching.
