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

## 7. Where the MVP stops

The Workers host renders `.astro` and `.md` for static routes, end to end, in real
workerd. Measured HTML parity against `pletivo build` on the same sources —
nothing normalised on either side:

| fixture | pages | byte-identical |
|---|---|---|
| `tests/conformance/fixtures/css-cascade-order` | 4 | 3 |
| `tests/fixture-astro-hoisted-imports` | 1 | 0 |
| `tests/fixture-astro-styles` | 4 | 0 |

**The first wall is TypeScript in `.astro` frontmatter.** `interface Props` is the
documented Astro idiom, so this hits nearly every real project (15 of this repo's
own 142 `.astro` files). `@astrojs/compiler` copies frontmatter into its output
verbatim and the Worker Loader takes JavaScript, so the module does not parse.
The fix is a pure-JS transpiler in the *host* worker, ahead of the Loader.

Sizes, measured rather than guessed — `bun build --target=node --minify`, gzipped:

| candidate | minified | gzipped |
|---|---|---|
| `ts-blank-space` | 3.65 MB | 1.01 MB |
| `sucrase` | 298 KB | **62 KB** |

`ts-blank-space` looks like the minimal choice — it only blanks out type syntax —
but it depends on the whole `typescript` package for the parse, so it is 16×
larger on the wire. Against a Worker's 10 MB gzip deploy limit that is not fatal,
but it buys nothing: sucrase is self-contained and also handles JSX, which is the
same seam `.tsx` pages need. Watch its Node-only CLI deps (`mz`, `pirates`,
`commander`, `tinyglobby`) — the transform entry must not drag them in.

Delete only the `export interface Props` blocks from `tests/fixture-astro-styles`
and the same fixture renders **4/4 byte-identical**. So scoped CSS, the
`is:global` gating that runs through the render tracker, the no-`<head>` fallback
and cascade order already match — TypeScript is the only thing between that
fixture and full parity.

Behind that wall, in the order a project would hit them: `.tsx`/`.ts` pages
(same transpiler problem), dynamic routes (`getStaticPaths()` needs the page
module executed on the host), endpoints, islands, hoisted-script bundling, the
CSS bundle-and-hash pipeline, and Tailwind — `tailwind.ts` exists but is not
wired into `renderPage`.

Two mechanical constraints: the whole project is recompiled per request (only the
*isolate* is content-addressed, by module-map hash), and file-map keys must not
contain `..`, since `resolveSpecifier` drops a climb past the root.

## Parity that does hold

- **compiler, Bun-side:** 114/114 `.astro` files across every fixture in this
  repo, byte-identical on `code`, `css`, `scope`, `scripts`, `containsHead`,
  `propagation` and `diagnostics`
- **compiler, in workerd:** 32/32 byte-identical against the Bun host
- **Tailwind output, in workerd:** identical bytes (4979 B) for the same input
- **a full page, in workerd:** `.astro` layout + component + slots + scoped CSS,
  and a `.md` route rendered on the host, both served from an in-memory file map

## A diagnostic that lied, and what it teaches

`IsolateStartError` used to report TypeScript as the cause of *every* Loader
start failure. Handing the host a file map with `..` in its keys produced
unresolvable specifiers and the same message, pointing at annotations that were
not in the sources. Fixed in `1101194`: the note is attached only when a
generated module actually carries statement-level TypeScript, and names which.

Worth remembering when adding the next diagnostic here — the isolate boundary
hides the real error, so it is tempting to guess, and a confident wrong guess
costs more than no guess.

## Files

- `packages/workers/src/tailwind.ts` — scanner and the measured divergence note
- `packages/workers/src/astro-compiler.ts`, `src/vendor/wasm_exec.js`
- `packages/workers/src/rewrite-imports.ts`
