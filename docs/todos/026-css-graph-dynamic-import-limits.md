# 026 — Dynamic `import()` the CSS graph cannot follow

**Priority:** B-tier
**Status:** open, documented only; nothing in a known site depends on it
**Area:** build CSS chunking (`js-imported-css.ts`), `--incremental` (`incremental/`)

## What works

The build's CSS graph follows an `import()` with a string specifier the way it
follows a static import:
- a full build puts the CSS in the group of every page that reaches it, in import order;
- a page's cache entry keeps the graph modules it reaches only through `import()`
  (`dynamicGraph`). A page restored from the cache does not render, so those
  modules do not load. The warm build puts the recorded modules back, and its
  page walk equals a full build's.

Anything the walk cannot attribute goes in the shared sheet, which every page links.
The cases below are where that, or the restore, falls short.

## 1. A computed specifier

```js
export async function load(name) {
  return (await import(`./${name}.astro`)).default;
}
```

**Today** (probed with `vendor/Comp.astro` → `vendor/comp.css`):
- **Full build:** the component loads during the render, but no page reaches it in the graph, so its CSS goes in the shared sheet. Every page links it.
- **`--incremental` warm build:** the page is restored from the cache and `Comp.astro` does not load. The CSS is missing from every page.
- Editing `Comp.astro` does not re-render the page under `--incremental` either: the import graph does not see the edge. CLAUDE.md lists this under "Incremental build — dep tracking limits".

**Why:** both graphs read imports with Bun's `scanImports`, which reports an `import()` only when its argument is a string literal or a template literal without expressions.

**What a fix would need:** the modules a render actually loaded, recorded per page. Bun has no per-import hook for a runtime `import()`, so that means a loader plugin attributing every `onLoad` to the page rendering at the time, through `AsyncLocalStorage`. It must also cope with a module that another page loaded first, which no hook reports twice. #82 rejected attributing by load for that reason.

**Workaround:** an `import()` with a string specifier per component, or a static import.

## 2. A module inside `node_modules`

The CSS graph follows only relative specifiers that resolve inside the project.
The import graph skips `node_modules`, whose contents the lockfile pins.

**Today** (probed with a project `Dyn.svelte`, loaded through `import()`, that
imports `fake-lib/Button.svelte` with a `<style>` block):
- **Full build:** `Button.svelte` compiles and registers its CSS, but no edge leads to it, so its rule goes in the shared sheet.
- **Warm build:** the page is restored, and neither `Dyn.svelte` nor `Button.svelte` loads. `Dyn.svelte`'s node is restored, but it has no edge to `Button.svelte`, so the rule is missing (found in #82's review round 2).
- A package component imported statically, from any module that loads, is unaffected: it loads on every build and lands in the shared sheet.

**Why:** `resolveLocalModule` drops bare specifiers, so the node has no edge. The restore records only modules the page's walk or its incremental deps reach.

**What a fix would need:**
- resolve bare specifiers in `nodeItems` (`Bun.resolveSync`) and keep the edge when the target is a component a framework compiler handles;
- record those nodes, with their in-memory `<style>` text, like project modules.

That also attributes package component CSS to pages instead of the shared sheet, so it changes the output of every project that uses one. It needs its own measurement.

## 3. A tsconfig path alias

`import("@/components/C.astro")` is not followed by the CSS graph either: an
alias is a bare specifier. The CSS goes in the shared sheet. A static alias import
behaves the same way.

The warm build equals the full build here (probed): the import graph resolves the alias, so the page's deps reach the module and its node is recorded and restored, unattributed.

**What a fix would need:** resolve the alias through `Bun.resolveSync` in `resolveLocalModule`, as for (2). It moves CSS from the shared sheet into page groups for every project that imports through aliases. That is a bigger output change than this item, so measure it on a real site first.

## Restore limits

- **A recorded module no page loads any more:** its node is restored until the recording page renders again, so its CSS still ships. Extra CSS, never missing CSS.
- **A recorded stylesheet deleted since** through an edge neither graph sees: dropped on restore, not a build error.
- **Storage:** nodes are stored per route. N routes that dynamically import the same component store its node N times. Only in-memory `<style>` text is stored once per cache.
