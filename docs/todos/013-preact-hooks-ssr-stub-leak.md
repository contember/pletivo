# 013 — The SSR hooks stub leaks into client island bundles

**Priority:** S-tier
**Status:** Open
**Area:** Islands / Hydration

## Problem

Every hydrated island ships pletivo's server-side no-op hooks instead of
Preact's. `useState` returns `[value, () => {}]`, `useEffect` never runs. The
island mounts, renders once, and is inert — no error, no warning, just a
component that does not react.

## Root cause

`packages/runtime/src/hooks.ts` is a deliberate no-op stub for SSR, and the
tsconfigs map the bare specifier onto it:

```jsonc
// tsconfig.json and packages/pletivo/tsconfig.json
"paths": { "preact/hooks": ["./packages/runtime/src/hooks.ts"] }
```

Bun applies tsconfig `paths` **at runtime**, not only in `tsc`. So when
`islandPlugin()` builds the client bundle and asks for the real module:

```ts
// packages/pletivo/src/islands-bundle.ts
const preactHooks = resolve("preact/hooks");   // → packages/runtime/src/hooks.ts
```

it gets the stub back, and then pins every `preact/hooks` import in the bundle
to it. The stub's own doc comment ("On the client, Bun plugin resolves
`preact/hooks` to real Preact") describes what was intended, not what happens.

Only the subpath is hijacked — `resolve("preact")` returns the real package —
so the bundle contains genuine preact core next to fake hooks.

## Evidence

- `require.resolve("preact/hooks")` → `packages/runtime/src/hooks.ts`
- `require.resolve("preact")` → the real `node_modules/preact`
- island bundle built with the stub: 4,181 B; with real hooks: 20,608 B
- the shipped `Counter.js` carries preact-core markers but none of the
  hooks-specific ones (`__H`, `__N`)

Origin: commit `adc1e30`. `packages/pletivo/package.json` has no `files` field,
so that tsconfig ships to npm and the mapping reaches installed projects.

## Consequences beyond the bug

`scripts/benchmark.sh` compares pletivo bundling ~4 KB of stub against Astro
bundling a real framework. Any island-bundle size or build-time number taken
before this is fixed is not comparing the same work.

## Resolution behaviour, measured

Probed against this repo's real preact install (`preact@10.29.1`), from a
throwaway project so the mapping could be turned on and off:

| call | result |
|---|---|
| `require.resolve("preact/hooks")` — mapping on | the stub |
| `require.resolve("preact/hooks", {paths: [projectRoot]})` — mapping on | **the stub** |
| `Bun.resolveSync("preact/hooks", preactPackageRoot)` — mapping on | **the stub** |
| `Bun.resolveSync("./hooks", preactPackageRoot)` — mapping on | `hooks/dist/hooks.js` |
| `Bun.resolveSync("preact/hooks", cwd)` — mapping off | `hooks/dist/hooks.mjs` |

Two things follow.

**Re-rooting the resolve does not escape the mapping.** Bun walks up from the
resolve base to find a tsconfig, and `node_modules/.bun/preact@…/preact` is
*under* the repo root, so the repo's `paths` still apply. The obvious fix —
"resolve from the project root instead" — does not work. Only a **relative**
specifier escapes, because `paths` applies to bare specifiers only.

**The relative escape hatch lands on the wrong condition.** `./hooks` resolves
through the nested `hooks/package.json` and yields the CJS `hooks.js`, while
ground truth for an ESM bundle is the `import` condition, `hooks.mjs`.

## Fix direction

Keep the SSR mapping — SSR genuinely wants the no-op stub — and resolve the
client copy in `islandPlugin` from preact's own `exports` map: read
`<preactRoot>/package.json`, take `exports["./hooks"]`, prefer `import`, and
fall back to `Bun.resolveSync("./hooks", preactRoot)` for packages with no
exports map. Apply it uniformly to every preact subpath (`compat`,
`jsx-runtime`, …), not just `hooks` — those are only safe today because nobody
has mapped them, and a user's own tsconfig can.

The alternative worth weighing: drop the tsconfig mapping entirely and do the
SSR redirect in the Bun plugin layer that already exists (`astro-plugin.ts`,
`dev-ts-plugin.ts` both register `Bun.plugin`). That puts the redirect where
module loading actually happens instead of in a blunt global, but it moves a
module-resolution boundary, so it is a separate decision.

A regression test has to assert on bundle *content* (a hooks-specific marker,
or that the resolved path is under `node_modules/preact`), because the
failure mode is a green build that produces a dead island.

## Files

- `packages/pletivo/src/islands-bundle.ts` — `islandPlugin()`, the `resolve()` helper
- `packages/runtime/src/hooks.ts` — the SSR stub (correct as-is, wrong destination)
- `tsconfig.json`, `packages/pletivo/tsconfig.json` — the `preact/hooks` mapping
