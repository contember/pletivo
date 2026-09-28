# 013 — The SSR hooks stub leaks into client island bundles

**Priority:** S-tier
**Status:** Done — `a7f816a`
**Area:** Islands / Hydration

## Problem

Every hydrated island shipped pletivo's server-side no-op hooks instead of
Preact's. `useState` returned `[value, () => {}]`, `useEffect` never ran. The
island mounted, rendered once, and was inert — no error, no warning, just a
component that did not react.

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

The two byte counts above were measured on a bare bundle. Through the real
build, `examples/basic`'s `_islands/Counter.js` went 14,337 B → 15,165 B: the
stub build already carried minified preact core, and the ESM hooks build is
tree-shaken down to the one hook the island uses.

Origin: commit `adc1e30`. Up to and including `pletivo@0.1.35`,
`packages/pletivo/package.json` had no `files` field, so that tsconfig shipped
to npm and the mapping reached installed projects too.

## What the packaging change already closed

The release packager stages a `files: ["src", "README.md"]` manifest, so the
tarball no longer carries a tsconfig. Measured in a project that installs it:

| call, from inside `node_modules/pletivo/src` | 0.1.35 | packaged tarball |
|---|---|---|
| `require.resolve("preact/hooks")` | the stub | the real `preact/hooks` |

That leaves the bug repo-local. `islandPlugin()` resolves `preact/hooks` from
the project root first and only falls back to a pletivo-relative resolve, and
in an installed project the first branch already returns real preact — so what
still hijacks the specifier is this repo's own `tsconfig.json`, which is where
examples and benchmarks build.

## Consequences beyond the bug

`scripts/benchmark.sh` compared pletivo bundling a stub against Astro bundling
a real framework. **Every island-bundle size and build-time number taken before
`a7f816a` is not comparing the same work — re-run `scripts/benchmark.sh` before
quoting any of them.**

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

## Fix, as shipped in `a7f816a`

The SSR mapping stays — SSR genuinely wants the no-op stub. `islandPlugin`
resolves the client copy from preact's own `exports` map instead: find the
package root by walking up from `resolve("preact")`, read its `package.json`,
take `exports["./<subpath>"]` and prefer the `import` condition, falling back to
`Bun.resolveSync("./<subpath>", preactRoot)` for packages with no exports map
and to the old bare resolve after that. Applied to every subpath — `hooks`,
`compat`, `jsx-runtime`, `jsx-dev-runtime` — not just the mapped one; the others
were only safe because nobody had mapped them yet. The package *root* still
comes from the project's node_modules, unchanged: a second preact instance
breaks Radix's context registry.

Side effect worth knowing: `compat` and `jsx-runtime` move off their CJS build
onto the ESM one, so hooks now tree-shake.

The alternative not taken: drop the tsconfig mapping entirely and do the SSR
redirect in the Bun plugin layer that already exists (`astro-plugin.ts`,
`dev-ts-plugin.ts` both register `Bun.plugin`). That puts the redirect where
module loading actually happens instead of in a blunt global, but it moves a
module-resolution boundary, so it stays a separate decision.

## Regression coverage

`tests/unit/islands-preact-resolve.test.ts`. It never asserts that the build
succeeded — a green build is what hid this for the whole life of the bug. It
asserts on resolved paths, on bundle bytes (`__H` / `__N`, preact's mangled
hook-state internals), and at runtime by importing the built bundle and
checking preact's hooks installed themselves on the *same* `options` object the
island renders with — which pins the dedupe as well. It also pins the other
direction: server-side `preact/hooks` is still the stub module by identity.
Against the unfixed plugin, 9 of its 17 cases fail.

Note the conformance snapshots did **not** move. The harness deliberately does
not compare JS bundle contents, and island bundles are emitted unhashed as
`_islands/<Name>.js`, so a bundle can change from inert to working without a
single snapshot line changing. That is the same blind spot that let this ship.

## Files

- `packages/pletivo/src/islands-bundle.ts` — `islandPlugin()`, `resolveSubpath()`
- `tests/unit/islands-preact-resolve.test.ts` — the regression coverage
- `packages/runtime/src/hooks.ts` — the SSR stub (correct as-is; its doc comment
  describes the client redirect, which is only true as of `a7f816a`)
- `tsconfig.json`, `packages/pletivo/tsconfig.json` — the `preact/hooks` mapping,
  deliberately kept
