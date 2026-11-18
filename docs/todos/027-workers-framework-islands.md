# 027 — Framework islands on the Workers host

**Priority:** A-tier
**Status:** server render (W1), client bundles (W2) and the framework examples' parity (W3) done.
framework-preact is checked outside the repo, and with-mdx keeps its one Shiki difference, both by decision (below).
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
- **Evidence.** `fixture-parity.test.ts` asserts, against `pletivo build`:
  - `fixture-astro-renderers-multi`: the page byte-identical, its 18 island modules served,
    their import graph closed, 18/18 byte-identical;
  - the single-renderer fixtures react, solid, svelte and vue: 3/3 island modules each, and
    every page byte-identical once both inlined head `<style>` texts went through the Bun
    host's minifier (below). All four pass; svelte and vue also check the `url()` target
    file against the build's.

  Astro's framework-multiple gives 18/18 modules, by hand.

## What W3 built

Astro's framework examples, against `pletivo build`, and hydrating in a browser.

- **Two fixes in this host**, each found by an example:
  - the stylesheet and the page's own scoped CSS share one `<style>` where the build inlines the
    sheet, as it merges an inlined sheet with the page CSS (Astro's `mergeInlineCss`). The artifact
    carries `build.inlineStylesheets` and a numeric `vite.build.assetsInlineLimit` for it; the decision
    and its one near-limit divergence under `"auto"` are in 016. Every example with a component
    stylesheet hit the merge. A page whose build links its sheet next to a scoped `<style>` passed
    before W3 and passes again (`tests/fixture-astro-stylesheet-{linked,never}`); the first version of
    this fix merged it too. The same `assetsInlineLimit` now decides a bundled sheet's `url()` inline.
  - the style graph is one edge list in walk order, so a stylesheet a module imports before a
    component comes before that component's CSS: the order Astro/Vite emit (014). Two lists put a
    module's own CSS after all its imports' CSS: framework-preact imports `Counter.css`, then lazily
    `Message`, and got `.message` before `.counter`. `pletivo build` without Tailwind concatenates
    `src/**/*.css` in path order instead, so framework-preact matched only because `Counter.css` sorts
    before `Message.css`. The build follows the import graph once its own fix lands; until then
    `tests/fixture-astro-css-import-order` (the page imports `z.css`, then a component importing
    `a.css`) fails parity, by design.
- **Evidence.** `fixture-parity.test.ts` also asserts `tests/fixture-astro-{react,solid,svelte,vue,multiple}-example`,
  Astro's examples with their sources as written: the page byte-identical (inlined `<style>` compared
  minified), 3 island modules each (18 for multiple) served, their imports closed and byte-identical.
  `tests/fixture-astro-mdx-example` stays the with-mdx mirror, highlighting off.
- **The examples as written**, `local-parity.ts` on a copy outside the repo: framework-preact, -react,
  -solid, -svelte, -vue and -multiple 1/1 pages and every island module byte-identical (7, 3, 3, 3,
  3, 18). with-mdx: 5/5 modules, and the page differs only in its code block, which the build
  highlights with Shiki and this host does not (016).
- **framework-preact is not a repo fixture, by decision.** The root `tsconfig.json` maps `preact/hooks`
  to the SSR stub for everything under the repo, `node_modules` included, and the stub has no `useId`,
  `useDebugValue` or `useImperativeHandle`, which `preact/compat` imports: `pletivo build` itself
  fails on it here. It also imports `@preact/signals`, which the workspace has only transitively.
  The run outside the repo above is the evidence; neither the stub nor the tsconfig changes for it.
- **with-mdx's code block stays a recorded exception, by decision:** this host leaves fenced code
  unhighlighted (016).
- **Browser check**, through `createProjectHost` in workerd (`wrangler dev --local`, Worker Loader),
  each example prepared and served by `host.fetch`, in headless Chrome: framework-multiple, the
  with-mdx fixture and the five single-framework examples. Every `astro-island` lost its `ssr`
  attribute; clicking `+` moved each counter (framework-multiple: React, Preact, Solid, Vue and Svelte
  each on its own; framework-preact's two islands share one signal and both showed the new value, with
  the lazy `Message` loaded); every island module answered 200; the console had no messages and no
  page errors.

## What is left

- **Prepare's working directory.** Bun names a shared chunk by its path relative to the working
  directory (025). The CLI runs both `pletivo build` and `pletivo prepare` from the project
  root, so they agree. Calling `prepare(root)` from another directory names every chunk, and so
  every module importing one, differently: 1 of 18 matched on the multi fixture. `build(root)`
  does the same.
- **CSS in an Astro project.** `pletivo build` inlines a small sheet minified, with
  `@import` flattened and `url()` rewritten to `/assets/<name>.<hash>.<ext>`; this host
  inlines the per-page sheet as written, labelled per file (023 §5). The parity harness
  (`test/inlined-style.ts`) pairs the head `<style>` blocks in order, passes the first pair
  whose texts differ through the Bun host's `minifyCss` and compares the whole page byte
  for byte; a sheet missing one rule fails it, and a sheet the minifier rejects is named.
  A relative `url()` and a dangling `@import` in a bundled sheet were fixed in this host
  (#98), and the two-block `<style>` in W3. Under `"auto"` a sheet near the limit can be inlined
  by the build and not here, or the reverse (016).
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
- **Islands from an `.mdx` page** follow the same rule (b): prepare compiles each `.mdx`
  file and builds clients for its hydrations, and link rewrites its `client:component-path`
  as it does an `.astro` file's ([016](016-workers-host-divergences.md), "MDX pages").
- **Shared helpers are two instances.** A project module only components import is
  bundled and kept out of the vendor graph. One a live module imports too is bundled and
  also compiled live, so module state is not shared between the two; when its imports
  cannot be carried for the live copy, prepare refuses it by name.
- **`tests/fixture-astro-renderers-preact`: refused for parity.** Its endpoint imports
  `astro/container`, which reaches `node:path`, so prepare fails, and this host has no
  endpoint routes. Preact is covered on Workers by the multi fixture and by framework-preact as
  written, outside the repo (W3).
