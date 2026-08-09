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
- A thrown `astro:config:setup` does not disable the integration for the process. The failure lands in `host.setupErrors`, rides on the dev error overlay, and the hook is re-run on every file change (rate-limited on requests) until it passes. Hooks are therefore re-entrant: the retry context dedupes `injectRoute` / `injectScript` / `updateConfig` so a partially-applied hook does not register its side effects twice.
- Build CSS is chunked by *the set of page entries that reach a CSS module* (`planJsImportedCss`), one stylesheet per set plus a shared sheet. A page whose module graph wasn't collected this build — restored from the incremental cache, or a dynamic route whose module was never imported — has unknown reach and must link **every** group; dropping that fallback silently loses CSS. Anything the page walk can't attribute (hoisted-script CSS, modules reached only through a dynamic import) goes in the shared sheet, never nowhere.
- `url()` targets in CSS are rewritten to hashed files by `css-assets.ts` *before* Bun loads the stylesheet, because Bun inlines everything up to 131,071 B as base64 and exposes no threshold. The rewritten URL carries a placeholder origin (`https://pletivo-asset-placeholder.invalid`) — Bun fails the build on an absolute `url(/…)` it cannot resolve but leaves `http(s):` alone — which `stripCssAssetPlaceholders` removes from the built CSS. Extraction is off unless `configureCssAssets` ran, so dev keeps inlining.
- `pletivo dev` is two processes: a supervisor parent and the server child (`PLETIVO_DEV_CHILD=1`). The child exits with `RESTART_EXIT_CODE` (75) when `astro.config.*`, `pletivo.config.*` or any project module they import changes — the astro host is built once per process and Bun plugins cannot be unregistered, so a new process is the only way to apply a new config. The parent also restarts a crashed child with backoff, up to a small budget, then exits with the child's code so an external supervisor can take over. `--no-restart` turns both off, which also switches the config watcher off.

## Incremental build — dep tracking limits

`build` is a full rebuild by default; pass `--incremental` to opt into the cache (which lives in `node_modules/.pletivo/cache/`). Two layers feed the dep tracker:

1. **Static ESM graph** (`incremental/import-graph.ts`) — parses page source with Bun's transpiler + `@astrojs/compiler` for `.astro` + `@mdx-js/mdx` for `.mdx`. Catches any module reachable through a static `import` / `import()`.
2. **Runtime capture** (`incremental/dep-tracker.ts`) — AsyncLocalStorage-scoped `recordRuntimeDep(path)` calls fired from `getCollection`, `probeAndRegisterImage`, and the `glob()` loader.

**What is NOT tracked (known limitation, only relevant under `--incremental`):** direct `Bun.file()` / `fs.readFile()` / `import()` calls in user components that read an arbitrary data file. There is no general-purpose way to intercept these without monkey-patching globals. Workarounds:

- Route the read through a content collection (`getCollection` is tracked).
- Use static ESM `import` for JSON / data modules (`import data from "./data.json"` is in the static graph).
- For one-off external data changes, run a plain `pletivo build` (full rebuild) or `pletivo build --incremental --clean`.

Run `--incremental --clean` after upgrading pletivo or after any environment change you suspect the cache isn't catching.
