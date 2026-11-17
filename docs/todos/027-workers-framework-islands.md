# 027 — Framework islands on the Workers host

**Priority:** A-tier
**Status:** server render (W1) and client bundles (W2) done. The framework examples' parity (W3) is open.
**Area:** Workers host, Astro islands, prepare

## What W1 built

A Workers render of a page that uses React, Preact, Solid, Svelte or Vue components,
through the project's `@astrojs/*` integrations, emits the `<astro-island>` markup
`pletivo build` emits: each integration's server renderer, Astro's prebuilt island and
directive scripts, and the same `component-url`, `renderer-url` and `uid`.

- **Prepare** (`packages/pletivo/src/prepare/islands.ts`), only when the project
  registered renderers. Every project file a renderer's compiler claims (target
  `server`) is compiled with the compilers `pletivo build` uses and bundled with every
  renderer's server entrypoint in **one** `Bun.build` (ESM, splitting, `workerd`/`worker`
  conditions, production `NODE_ENV`). One graph, so a component and its renderer share
  one framework runtime; React's hooks need that. The integrations' Vite virtual modules
  are served from their plugins, as on the Bun host.
- **Artifact** (`packages/core/src/artifact.ts`): an optional `islands` field — the
  renderers in registration order with their server module, Astro's island scripts, each
  claimed file → its bundle module (`islands-bundle:<digest>/…`), each compiled
  component's CSS, and the absolute project root at prepare. Optional, so
  `ARTIFACT_VERSION` stays 2. `node:async_hooks` is the one built-in a bundle module may
  import (Svelte's server runtime); a project file still may not.
- **Isolate**: the resolver answers a claimed file with its bundle module before the
  file's own compile, so a claimed `.tsx` never compiles as pletivo JSX. A file no
  prepared compiler claimed is refused by framework name, as before. Link rewrites each
  `.astro` module's `client:component-path` to the absolute path the Bun host compiles
  in, because the island `uid` hashes that string; the artifact carries the root for
  that. `createIslandClientUrls` moved to `packages/core/src/island-urls.ts` (with a
  portable synchronous SHA-256) and both hosts name island files through it. The isolate
  configures `configureAstroIslands` once and runs `finalizeIslandScripts` per render.
- **CSS stays live.** A component's `import "./x.css"` leaves the bundle as an import of
  that project file. A Svelte/Vue component's compiled CSS becomes a virtual project
  stylesheet beside the component (`Counter.vue.pletivo-style.css`, the Bun host's name),
  so its own `@import` and `url()` resolve against the project like any other CSS.
  Editing a component's script or template needs a new prepare: every project file the
  bundle compiled is a prepare input, so a stale bundle is reported like a stale config.

## What W2 built

The JavaScript at every island URL a Workers render emits, served by the host.

- **Which components get a client module.** Prepare renders no page, so it takes what the
  `.astro` files hydrate: the sources, the project's own outside `srcDir` (a layout beside it,
  outside `node_modules` and dot directories) and the package `.astro` components the vendor
  graph carries. It compiles each with the Astro compiler and the Bun host's
  `resolvePath` (`resolveComponentPath`), and reads `hydratedComponents` and
  `clientOnlyComponents`. A `component-url` hashes the import **as spelled**
  (`../components/Counter`, `.jsx` falling back to `.tsx`, a directory for an `index`), so the
  entry set is (spelling, export) pairs, not files. Enumerating every export of every claimed
  file instead names URLs no page asks for: both measured projects import without extensions.
  Every hydration found is built, an unused `.astro` file's too; one that fails names the
  `.astro` files that asked for it.
- **The same bundler.** `buildAstroIslands` (`astro-islands-bundle.ts`) is `pletivo build`'s
  island bundler, in memory: same compilers (client target), Bun.build options, Vite plugins.
  Its entries are sorted by URL on both hosts. Bun names cross-chunk exports in entry order, and
  the order components finish rendering in is one prepare cannot see; unsorted,
  framework-multiple matched 11 of 18 modules, sorted 18 of 18.
- **The rule, and its failure.** A later `.astro` edit that moves, adds or removes islands of
  components already hydrated somewhere stays live. One that hydrates a component, an export or
  an import spelling no `.astro` hydrated at prepare fails its render with
  `MissingIslandClientError`, naming the missing URL and asking for a new prepare
  (`packages/workers/test/island-clients.test.ts`). A framework component's own edit needed a new
  prepare already.
- **Artifact.** `islands.clients`: each module's `url` (`/_astro/<file>.js`), `source`, whether
  it is a content-named `chunk`, the client `imports` it loads and the project `sources` it was
  bundled from. Required, and parsed strictly: unique URLs, and every listed import another
  client module, so the listed graph closes where the artifact enters. The parser checks the
  list, not the `source`; prepare derives the list from the code, failing on an import outside
  the client bundle. `ARTIFACT_VERSION` stays 2: a W1 host refuses the unknown field, this host the
  missing one. The client build's project reads are digested before it reads them, as the server
  bundle's are, so an edit racing prepare reads as stale.
- **Serving.** `island-clients.ts`, after the browser modules and before `public/`. A module Bun
  emitted as a chunk (`chunk: true`) is content-named and `immutable`; every other client module
  is named by its path (025), a component file called `chunk-list.jsx` included, and goes out
  `no-cache` with an `ETag` of its source, as it changes under its URL with the next prepare. A
  matching `If-None-Match` gets 304.
- **Tailwind (016's remaining hole).** A page's islands, their imports and the project files
  those were bundled from: those files' current text joins the page's candidates. That is what
  the Bun host's scan reads, the project's sources and no `node_modules`; the bundle text would
  add about 3 300 candidates from the frameworks' runtimes on the multi fixture.
- **Evidence.** `fixture-astro-renderers-multi`: the page byte-identical, its 18 island modules
  served, their import graph closed, 18/18 byte-identical to `pletivo build`. The four
  single-renderer fixtures (react, solid, svelte, vue) give 3/3 each, and Astro's
  framework-multiple 18/18, by hand; their HTML waits on the CSS decision below.

## What is left

- **W3, parity for the framework examples.**
- **The CSS delivery decision** below, which the single-renderer fixtures' HTML waits on.
- **Prepare's working directory.** Bun names a shared chunk by its path relative to the working
  directory (025). The CLI runs both `pletivo build` and `pletivo prepare` from the project
  root, so they agree. Calling `prepare(root)` from another directory names every chunk, and so
  every module importing one, differently: 1 of 18 matched on the multi fixture. `build(root)`
  does the same.
- **CSS delivery in an Astro project.** `pletivo build` inlines a small sheet minified,
  with `@import` flattened and `url()` rewritten to `/assets/<name>.<hash>.<ext>`; this
  host inlines the per-page sheet as written, labelled per file (023 §5). The harness
  excepts that fork only where the build *links* a sheet, so the renderer fixtures whose
  components carry CSS do not compare byte-for-byte; the markup outside the head
  `<style>` does. A `url()` in such CSS is left relative to the page here, which is a
  real broken image, not only a byte difference.
- **Refused by name at prepare:**
  - a component importing a package stylesheet, or a stylesheet with a query;
  - a `.svelte` or `.vue` component from a package that has a `<style>`: its compiled CSS
    would sit beside it in `node_modules`, which is not a project file;
  - a non-JS asset (an image import in a component), naming the importing component and the
    file, from the server bundle or, when only the browser conditions reach it, the client
    bundle: the artifact carries JavaScript client modules only. `pletivo build` writes such an
    asset byte for byte;
  - a hydrated component whose island module name would start with `.` (a `.Counter.jsx`),
    which the host does not serve, naming the `.astro` file that hydrates it;
  - a Node built-in other than `node:async_hooks` and `node:crypto`, bare or `node:`,
    static or dynamic, naming the importing file. The render isolate runs under
    `nodejs_compat`, which provides both; Svelte's server runtime imports both. Those two
    are refused too by their bare names and through `require()`. Only a string-literal
    specifier is seen: a computed `import()` of a built-in reaches the isolate unchecked;
  - a base other than `/` and `before-hydration` scripts (prepare already refused both).
- **Bun 1.3.14 crashes** (segfault) when any `onLoad` hook, a pass-through one too, matches a
  file it emits as an asset. The prepare and island bundlers' read trackers therefore match only
  the extensions Bun loads as source or text plus the framework compilers', so the asset reaches
  the named refusal above.
- **`client:component-path` from MDX** is not rewritten; MDX does not compile in the
  isolate yet.
- **Shared helpers are two instances.** A project module only components import is
  bundled and kept out of the vendor graph. One a live module imports too is bundled and
  also compiled live, so module state is not shared between the two; when its imports
  cannot be carried for the live copy, prepare refuses it by name.
- **`tests/fixture-astro-renderers-preact`** still cannot be prepared: its endpoint imports
  `astro/container`, which reaches `node:path`, and this host has no endpoint routes.
