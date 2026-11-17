# 025 — Content-hashed island and hoisted-script URLs

**Priority:** B-tier
**Status:** deferred; a probe is measured and kept on the `probe/island-prebundle` branch (7345a52). The hosting rule is in the README.
**Area:** Astro islands, hoisted scripts, build

## The gap

In an Astro project, `pletivo build` emits island entries under `_astro/`:
- `<Name>.<hash>.js`, one per hydrated component, hashed from the component path and the export name;
- `client.<hash>.js` per renderer, hashed from the renderer name;
- `before-hydration.<hash>.js`, hashed from the joined script source.

See `createIslandClientUrls` in `packages/pletivo/src/astro-islands-bundle.ts`.
None of them is hashed from the bundled code. The render needs the URLs, so they
are fixed before the bundle exists. Chunks shared
between entries are content-hashed by Bun (`chunk-<hash>.js`).

Hoisted scripts have the same gap. `_astro/hoisted-<hash>.js` hashes the
inline `<script>` source (`astro-plugin.ts`), but the bundle inlines the
modules that script imports, so a changed import keeps the URL.

Astro names these files by content, as Vite does. So a host that serves
`/_astro/*` as `immutable`, as Astro's own output allows, can serve a stale
pletivo file after a deploy that changed the code it bundles: a component, one
of its imports, or a framework version. The stale file either runs the old code,
or fails to hydrate the island if the chunks it imports are gone.

A deploy that changes none of that code is unaffected.

**The risk is unverified.** No site is known to combine pletivo islands with
`immutable` caching of `/_astro/*`. Until this is fixed, the README tells hosts
to serve every `/_astro/*.js` except `chunk-*.js` with `no-cache`. A CDN purge alone
cannot evict a browser's `immutable` copy.

## When to come back

When a site has framework islands or hoisted scripts built by pletivo *and*
serves `/_astro/*` as `immutable` (or needs to). Hoisted scripts look cheaper
(not probed): the build already rewrites their tags in the written pages after
bundling them, since it inlines small ones, so a content hash may need only that
rewrite plus the same `--incremental` refresh.

## Option A: bundle before the render

The probe bundles islands before the render and takes each entry URL from the bundle output.

**How it finds the hydrated set:**
- **`.astro`:** the Bun loader already runs `transform()` in `astro-plugin.ts`, and the probe records its `hydratedComponents` and `clientOnlyComponents` per file. `resolvedPath` goes through `decodeURI` to match the runtime's key.
- **MDX:** `mdx-island-metadata.ts` already resolves path and export for every `client:*` element, and the probe records the pair.
- **Pre-pass:** after `getStaticPaths`, which already imports every dynamic route in a full build, a pre-pass imports every static route module. Bun caches the modules, so nothing compiles twice.
- **Rejected:** a separate static scan, such as `incremental/import-graph.ts`, would compile every `.astro` a second time.

It over-approximates: every `client:*` component of a compiled file is bundled, even in a branch no page renders. Astro does the same.

**In a full build:**
- two identical builds give identical names;
- changing one string in `PreactCounter.tsx` changed only `PreactCounter.<hash>.js`;
- in all 6 framework examples, every `component-url` and `renderer-url` points to an existing file, and every relative chunk import resolves;
- no project bundled a component that no page hydrates (0 on the production site, the 6 framework examples and with-mdx).

### Measurement

Full builds, `main` (bad1e25) vs the probe, Bun 1.3.14, 2 dedicated cores. Each
config: 1 warm-up and 5 runs, `main` and probe interleaved per round. Wall time is
the median (min–max); RSS is the median peak.

| project | checkout | wall | peak RSS | islands bundled = hydrated |
|---|---|---|---|---|
| a production Astro site, 1314 pages | main | 10.61 s (9.29–11.81) | 837 MB | 0 |
| a production Astro site, 1314 pages | probe | 10.55 s (9.76–13.63) | 900 MB | 0 |
| a production Astro site, 1314 pages | probe, pre-pass forced | 10.39 s (9.42–11.43) | 839 MB | 0 (110 files compiled) |
| framework-preact | main / probe | 1.00 (0.85–1.17) / 0.90 (0.88–1.00) s | 233 / 237 MB | 1 |
| framework-react | main / probe | 0.81 (0.73–0.84) / 0.77 (0.75–0.85) s | 227 / 228 MB | 1 |
| framework-solid | main / probe | 1.04 (0.96–1.10) / 0.98 (0.95–1.07) s | 242 / 243 MB | 1 |
| framework-svelte | main / probe | 0.99 (0.95–1.09) / 1.01 (0.99–1.08) s | 246 / 250 MB | 1 |
| framework-vue | main / probe | 0.92 (0.86–1.03) / 0.87 (0.84–1.06) s | 240 / 241 MB | 1 |
| framework-multiple | main / probe | 1.43 (1.39–1.72) / 1.50 (1.37–1.63) s | 309 / 309 MB | 5 |

**How to read it:**
- The site's runs spread from −12 % to +11 % around `main`'s median, and the plain probe's up to +29 %. So its deltas (−0.6 %, and −2.1 % with the pre-pass forced) are noise.
- The site has no framework islands. The plain "probe" row skips the pre-pass there (no renderers), so its RSS difference is noise too. Only the "forced" row measures the pre-pass, and none of it is bundling at scale.
- No project with many islands was measured.

### What blocks it

1. **Components the pre-pass cannot see.** A component first compiled during the render gets no entry:
   - MDX content entries, which `renderMdx` imports lazily as `file?v=N`;
   - `await import()` or a lazy `import.meta.glob` inside a component;
   - under `--incremental`, dynamic routes on the cache fast path.

   The fix:
   - pre-import MDX content entries with the exact specifier `renderMdx` uses;
   - for the rest, fail the build with the component's name.

   Bundling the missed ones in a second pass is not a safe fallback, though this is untested: the island would get the first pass's `renderer-url`, so the page would load two copies of the framework runtime.
2. **`--incremental`.** Cached HTML carries the hashed URLs. An entry's hash changes when its own code changes, and also when a shared chunk it imports is renamed. Chunk names depend on the whole bundled set, so adding an island on one page can change the URLs on unchanged cached pages. So:
   - those pages need an in-place URL rewrite, as `refreshCachedCssHead` does for the CSS head (the cache already stores each page's `astroIslands`), or a re-render;
   - superseded files pile up in `_astro/`, which the orphan prune skips (`build.ts`).

   Path-based URLs avoid all of this.

**Not affected:**
- dev can keep path-based, lazy URLs, since a content hash would change on every edit;
- the Workers host does not bundle islands.

## Options considered

| option | outcome |
|---|---|
| A: bundle before the render, with the fixes for 1 and 2 | deferred: bigger than the risk it removes while that risk is unverified |
| B: placeholder URLs rewritten after the bundle | same incremental rewrite as A, plus a placeholder pass over every page |
| C: document the hosting rule | done (README) |
| A in full builds only, path URLs under `--incremental` | rejected: two URL schemes, and an untested switch between them |
