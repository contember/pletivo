# 027 — Framework islands on the Workers host

**Priority:** A-tier
**Status:** server render done (W1). Client bundles (W2) and the framework examples' parity (W3) are open.
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

## What is left

- **W2, client bundles.** The URLs are right and point at nothing on this host.
- **W3, parity for the framework examples.**
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
  - a non-JS asset (an image import in a component);
  - a Node built-in other than `node:async_hooks` and `node:crypto`, bare or `node:`,
    static or dynamic, naming the importing file. The render isolate runs under
    `nodejs_compat`, which provides both; Svelte's server runtime imports both. Those two
    are refused too by their bare names and through `require()`. Only a string-literal
    specifier is seen: a computed `import()` of a built-in reaches the isolate unchecked;
  - a base other than `/` and `before-hydration` scripts (prepare already refused both).
- **`client:component-path` from MDX** is not rewritten; MDX does not compile in the
  isolate yet.
- **Shared helpers are two instances.** A project module only components import is
  bundled and kept out of the vendor graph. One a live module imports too is bundled and
  also compiled live, so module state is not shared between the two; when its imports
  cannot be carried for the live copy, prepare refuses it by name.
- **`tests/fixture-astro-renderers-preact`** cannot be prepared: its endpoint imports
  `astro/container`, which reaches `node:path`, and this host has no endpoint routes.
