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
bun test packages/workers/test           # Workers host (its own CI step)

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

Bun workspace monorepo. The engine is split by *what host it can run on*, so a
second host (a Cloudflare Worker isolate) can reuse everything that is not Bun:

- **`packages/runtime`** — `@pletivo/runtime`. What ships into the output and runs at render time: JSX runtime (SSR), astro shim, islands, hydration, base-path. Zero host dependencies; the only import outside itself is `node:async_hooks`.
- **`packages/core`** — `@pletivo/core`. Host-agnostic logic: router, i18n, markdown pipeline, astro-host types, routes adapter, paginate, image service. May use `node:path`/`url`/`events`/`crypto` and pure-JS npm deps, but never `Bun.*`, `node:fs`, or `node:child_process`.
- **`packages/pletivo`** — the Bun host, and the only package published to npm: CLI, build, dev server with HMR, Bun loader plugins, CSS pipeline (Tailwind v4), content collections, incremental cache, astro-host runner.
- **`packages/workers`** — `@pletivo/workers`. The Cloudflare Worker host: `@astrojs/compiler` as Go wasm in-isolate, import rewriting against a virtual module graph, Tailwind v4 from a virtual file map. See `docs/todos/016` for where it diverges from Bun.
- **`packages/astro-jsx-pages`** — Babel+Vite plugin enabling TSX pages inside Astro. Built with tsc.
- **`examples/`** — `basic` (pletivo-native), `basic-astro`, `basic-astro-native`.

Neither `runtime` nor `core` has a build step, by design: `exports` points at
source. A `dist/` build would give modules that hold process-global state (base,
the island registry, the render-tracking store) two module records when one
importer resolves through `exports` and another through a relative path.

`tests/unit/package-boundaries.test.ts` enforces the split. If it fires, the
layering is broken — do not weaken it.

A handful of re-export stubs remain in `packages/pletivo/src/` on purpose:
`runtime/{jsx-runtime,hooks,astro-shim}.ts` and `content/index.ts` are named in
the package's `exports`, and Node forbids an `exports` target outside the package
directory. `runtime/astro-container.ts` and `i18n/virtual-module.ts` are pinned by
`pletivoSrcDir` string paths in `astro-plugin.ts`.

## Release

Only `pletivo` is published to npm. Core, runtime, and Astro JSX pages are
private workspace packages. Release stages a self-contained tarball — core and
runtime source copied under `pletivo/src/_internal/`, their specifiers rewritten
to package-private `#pletivo/*` imports — typechecks it as an external npm
consumer, then publishes that exact tarball via npm OIDC. It never publishes a
live workspace directory.

Release is triggered by pushing a `v*` tag (`.github/workflows/release.yml`).

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
- **Bun applies tsconfig `paths` at run time, not just in `tsc`.** `preact/hooks` is mapped to the SSR no-op stub, which is correct for SSR and wrong for anything building a client bundle. Re-rooting a resolve does not escape it — Bun walks up from the resolve base to find a tsconfig, and node_modules sits under the repo root. `islandPlugin()` therefore resolves preact subpaths through preact's own `exports` map. See `docs/todos/013`; this shipped broken for months because the build stayed green.
- Hoisted `.astro` CSS is emitted in **import-graph order** (depth-first post-order from the page module), not in loader or render order. That order is what the cascade resolves ties by. See `docs/todos/014`.
- A thrown `astro:config:setup` does not disable the integration for the process. The failure lands in `host.setupErrors`, rides on the dev error overlay, and the hook is re-run on every file change (rate-limited on requests) until it passes. Hooks are therefore re-entrant: the retry context dedupes `injectRoute` / `injectScript` / `updateConfig` so a partially-applied hook does not register its side effects twice.
- Build CSS is chunked by *the set of page entries that reach a CSS module* (`planJsImportedCss`), one stylesheet per set plus a shared sheet. A page whose module graph wasn't collected this build — restored from the incremental cache, or a dynamic route whose module was never imported — has unknown reach and must link **every** group; dropping that fallback silently loses CSS. Anything the page walk can't attribute (hoisted-script CSS, modules reached only through a dynamic import) goes in the shared sheet, never nowhere.
- `url()` targets in CSS are rewritten to hashed files by `css-assets.ts` *before* Bun loads the stylesheet, because Bun inlines everything up to 131,071 B as base64 and exposes no threshold. The rewritten URL carries a placeholder origin (`https://pletivo-asset-placeholder.invalid`) — Bun fails the build on an absolute `url(/…)` it cannot resolve but leaves `http(s):` alone — which `stripCssAssetPlaceholders` removes from the built CSS. Extraction is off unless `configureCssAssets` ran, so dev keeps inlining.
- Build stylesheets are minified (`css-minify.ts`), dev ones are not. The minify pass marks every `@import` and `url()` external, so it is a pure text transform: nothing is resolved, inlined or expanded. Tests that assert on emitted CSS must anchor on minified output (`.sel{prop:value}`).
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
