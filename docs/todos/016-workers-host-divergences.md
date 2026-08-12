# 016 — Workers host: known divergences from the Bun host

**Priority:** A-tier
**Status:** Open (documented, foundation landed)
**Area:** `@pletivo/workers`

`@pletivo/workers` renders the same sources as the Bun host inside a Cloudflare
Worker isolate, where there is no filesystem, no native addon, and no `eval`.
The compiler and the CSS engine had to be re-hosted, and re-hosting is where
divergence hides. These are the places the two hosts can disagree. Each was
measured, not estimated.

## 1. The Tailwind candidate scanner is a re-implementation

`@tailwindcss/oxide` is a native scanner that walks the filesystem — it cannot
run in an isolate. The candidate extractor is a JS re-implementation of oxide's
boundary rules (`crates/oxide/src/extractor/boundary.rs`).

Measured against `@tailwindcss/oxide` 4.3.3 over 7569 files from this repo:

- oxide reports 1039 candidates; **80 are missed**
- of those 80, **2 compile to CSS** under the default design system:
  - `border` — from CSS text inside a `<style>` block
  - `table` — from the word in markdown prose
- of the 7178 *extra* spans the JS scanner reports, **0 compile to anything**

Neither of the two is a class any page applies, so no page in the corpus renders
differently. But the two hosts *can* emit different CSS, and this is the seam it
would come through. Over-extraction is safe (Tailwind only builds candidates
that resolve); under-extraction is the risk.

## 2. `@source` globs are not applied

The whole virtual file map is scanned. A project that narrows scanning with
`@source` gets a superset of its candidates — extra utilities in the output,
never missing ones.

## 3. Tailwind JS plugins and configs are refused

`loadModule` cannot run: there is no module resolution in the isolate. A project
using a JS plugin or a `tailwind.config.js` gets an explicit error rather than
silently-missing utilities.

## 4. `wasm_exec` is vendored, and it used to clobber `process`

`@astrojs/compiler` is a Go wasm binary and needs Go's `wasm_exec` glue. The
package's *browser* chunk does an unconditional
`Object.defineProperties(globalThis, {fs, process})` — under Bun that replaced
`globalThis.process` outright and `process.env` became `undefined`.

The vendored copy guards both installs the way `@astrojs/compiler`'s own *node*
build does. `test/vendor-wasm-exec.test.ts` re-derives the file from the
installed package, so an upgrade that moves that chunk or that line fails loudly
instead of silently reintroducing the clobber.

Related constraint: the Go program owns a single `globalThis` slot, so **two
compilers cannot coexist in one process**. Parity tests run the two hosts in
separate processes for that reason.

## 5. Import rewriting is bounded by the module prologue

`@astrojs/compiler` leaves user imports exactly as written (`resolvePath` is
only consulted for client-directive component paths), so the Workers host
rewrites specifiers itself. It rewrites static imports **only inside the run of
import statements the module opens with**.

This is not conservatism for its own sake. The compiler puts the page body in a
template literal, so a page whose visible copy contains

```astro
import Layout from "../components/Layout.astro";
```

emits that line at column 0 — indistinguishable from a real import to any
line-anchored pattern. The original spike rewrote it and corrupted the page.
Verified fixed: the same input now leaves the body text untouched.

Consequences:

- an import placed *after* other statements is left alone — a missing module at
  bundle time, which is loud, rather than silently rewritten page copy
- dynamic `import()` is still matched anywhere, since it can legitimately sit in
  a function body; page copy containing a literal `import("./x")` would be
  rewritten

## 6. `resolveSpecifier` normalises away a leading `/`

Module-graph keys are root-relative without a leading slash
(`src/components/Layout.astro`). An importer passed as `/src/pages/index.astro`
resolves to the same key. Forgiving rather than wrong, but undocumented in the
function's own comment, which only mentions dropping a `..` that climbs past the
root.

## Parity that does hold

- **compiler, Bun-side:** 114/114 `.astro` files across every fixture in this
  repo, byte-identical on `code`, `css`, `scope`, `scripts`, `containsHead`,
  `propagation` and `diagnostics`
- **compiler, in workerd:** 32/32 byte-identical against the Bun host
- **Tailwind output, in workerd:** identical bytes (4979 B) for the same input

## Files

- `packages/workers/src/tailwind.ts` — scanner and the measured divergence note
- `packages/workers/src/astro-compiler.ts`, `src/vendor/wasm_exec.js`
- `packages/workers/src/rewrite-imports.ts`
