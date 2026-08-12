# 016 — Workers host: known divergences from the Bun host

**Priority:** A-tier
**Status:** Open (documented, foundation landed)
**Area:** `@pletivo/workers`

`@pletivo/workers` renders the same sources as the Bun host inside a Cloudflare
Worker isolate, where there is no filesystem, no native addon, and no `eval`.
The compiler and the CSS engine had to be re-hosted, and re-hosting is where
divergence hides. These are the places the two hosts can disagree. Each was
measured, not estimated.

## Current host contracts

These contracts landed after the measurements below. They are the current baseline:

- Prepared sites use Artifact V2: a closed module graph with importer-aware
  resolutions. The parser rejects malformed, duplicate, dangling, unknown-version,
  and unsupported inputs. Fatal prepare diagnostics prevent emission; diagnostics
  stay outside the executable artifact and its canonical identity.
- `ProgramHash` identifies the exact executable module set. `IsolateKey` separately
  includes tenant, capability generation, host ABI, compatibility date and flags,
  outbound policy, and immutable environment inputs. Request data is not isolate identity.
- Content state belongs to an explicit `ContentRuntime`. Bun enters its long-lived
  runtime with `runWithBunContentRuntime()`; each Loader request enters the Worker
  runtime scope. Hosts do not install or mutate a process-global content host.
- Assets belong to the outer host through `ProjectAssetsView`. `info(source)` and
  `resolveOutput(path)` are demand-driven; an unrelated request does not scan or hash
  the project asset set.
- This is a static host. A page that exports `prerender = false` is rejected explicitly;
  the host does not pretend that an HTML-only return value implements HTTP SSR.
- Only `pletivo` is published. Release builds a self-contained staged tarball containing
  its private core/runtime source copies. `@pletivo/workers` remains private source for
  applications to bundle.
- `example-playground/` is the sole live-workspace reference: the Durable Object owns
  the workspace, `ContentFiles`, and DO-self content binding. `example/` is an
  intentionally request-scoped, content-free preview.

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

The current page pipeline supplies candidates from rendered class attributes and
injected scripts; it does not evaluate filesystem globs. `@source` therefore cannot add
or remove candidate files. This is an explicit unsupported difference, not a guaranteed
superset: a class named only in an `@source` file would be missing.

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

The Workers host renders `.astro`, `.tsx`/`.ts` and `.md` for static routes, end
to end, in real workerd. Measured HTML parity against `pletivo build` on the same
sources — nothing normalised on either side, but for the one named exception below:

| fixture | pages | byte-identical | before the transpiler |
|---|---|---|---|
| `tests/fixture-astro-styles` | 4 | **4** | 0 |
| `tests/conformance/fixtures/css-cascade-order` | 4 | **4** | 3 |
| `packages/workers/test/fixture-tailwind` | 2 | **2**, CSS delivery excepted | — |
| `packages/workers/test/fixture-dynamic-routes` | 8 | **8** | — |
| `packages/workers/test/fixture-content` | 5 | **5** | — |
| `packages/workers/test/fixture-vendor` | 1 | **1** | — |
| `packages/workers/test/fixture-images` | 2 | **2** | — |
| `tests/fixture-astro-hoisted-imports` | 1 | 0 | 0 |

Only `fixture-tailwind` holds a `.css` file at all, so it is the only row the CSS
fork touches: one node is removed from each side (the `<link>` there, the leading
`<style>` here) and the rest of both pages still matches byte for byte. Everything
else is unnormalised on both sides.

The Tailwind fixture no longer compares an emitted `assets/styles.*.css`, because
this host emits none. It compares the engine instead: the same entry compiled with
the same project-wide candidate set is **8744 bytes, byte-identical** to the
Tailwind portion of what a `pletivo build` running the real `@tailwindcss/node` +
`@tailwindcss/oxide` wrote. All 16 utilities compile on both sides, so the JS
candidate scanner and oxide agree here — see §1 for where they provably do not.
Plus two checks the file comparison never made: every class the rendered page
applies is found by the scanner, and every one of those that is a utility is in the
CSS that page carries. All of it gated in `bun test` rather than run by hand.

### The transpiler seam

`@astrojs/compiler` copies `.astro` frontmatter into its output verbatim and the
Worker Loader takes JavaScript, so `export interface Props` — the documented
Astro idiom, in 15 of this repo's own 142 `.astro` files — used to arrive as
unparseable JavaScript. `src/transpile.ts` now runs sucrase over every generated
module in the **host** worker, ahead of the Loader. The same seam compiles JSX,
which is what put `.tsx` pages in reach.

Sizes, measured rather than guessed — `bun build --target=node --minify`, gzipped:

| candidate | minified | gzipped |
|---|---|---|
| `ts-blank-space` | 3.65 MB | 1.01 MB |
| `sucrase` | 298 KB | **62 KB** |

`ts-blank-space` looks like the minimal choice — it only blanks out type syntax —
but it depends on the whole `typescript` package for the parse, so it is 16×
larger on the wire, and it cannot do JSX. Its Node-only CLI deps (`mz`,
`pirates`, `commander`, `tinyglobby`) stay out of the bundle: esbuild takes
sucrase's `module` field, and `test/transpile.test.ts` fails if any of them or a
>150 KB gzip ever appears.

**`keepUnusedImports: true` is load-bearing, not a preference.** Sucrase's
default TypeScript transform elides unused imports, including the
`import * as $$module1` the Astro compiler emits and never references by name.
Dropping it would silently move the CSS cascade, since `collectSpecifiers` reads
the same prologue. With the flag, a module containing no TypeScript comes back
**byte-identical**, so the transform cannot disturb anything that already
rendered. Explicit `import type` is still removed.

### The CSS pipeline: the hosts fork here, on purpose

**This is the one divergence that is a decision rather than a limitation.** The
Bun host builds one stylesheet for the whole site and links it from every page.
The Workers host builds the CSS of **the page it just rendered** and inlines it
in a `<style>`; it links nothing and returns no stylesheet asset. Taken in
[023 §5](023-live-workspace-architecture.md), and permanent.

The reason is not aesthetics. One project-wide sheet needs every route's CSS
imports, which needs every module compiled — measured on the static dogfood site, **109 modules
per request where the page reaches 14**. The CSS model and the compile cost were
one decision, so the CSS had to move first. What it buys, same project, five
pages through this host:

| candidates from | count | CSS | build |
|---|---|---|---|
| `src/` scan (the old model) | 22 657 | 83.8 kB | 190 ms |
| the rendered page | 961–1 275 | 39.5–50.1 kB | 19–30 ms |

Tailwind's primary content is the rendered HTML, the way the Tailwind CDN works.
`pageStylesheet` extracts candidates only from decoded `class` attributes, then adds
candidates from both injected-script categories because those scripts can create
classes. Two consequences worth naming:

- The scoped `<style>` blocks are **not** scanned — `finalizeHtml` injects them
  after the render, so they are not in the HTML that is read. That sidesteps
  `border`, one of the two false candidates in §1, which comes from CSS text
  inside a `<style>`.
- **The remaining hole:** a class that appears only in a future client bundle, not in
  rendered HTML or an injected script, is absent. It is theoretical today because this
  host ships **no client bundles at all**. When islands land, their shipped bundle text
  must join the candidate source.

Stylesheet ownership is now the compiler's `ResolvedStyleGraph`, shared with executable
resolution. Project and Artifact V2 package CSS use the same logical module edges; the
CSS pipeline does not resolve imports independently or scan every source stylesheet.
Assembly follows canonical graph order, substitutes one Tailwind result at the consumed
`@import` closure's position, and emits every stylesheet at most once. This preserves
equal-specificity cascade order before and after the Tailwind entry.

**What the fork cost, and what replaced it.** `fixture-tailwind` used to be the
only assertion anywhere that this host's JS candidate scanner plus Tailwind over a
virtual file map emits the **same bytes** as the real `@tailwindcss/node` +
`@tailwindcss/oxide` — and it made that claim by comparing the linked stylesheet
file, which no longer exists. `local-parity.ts` re-makes it one level down:
compile the same entry with the **old project-wide candidate set** and assert byte
equality against the Tailwind portion of what `pletivo build` wrote. **8744 B,
byte-identical.** Same claim about the engine, independent of delivery.

That comparison never covered the thing the new model actually risks, so two
per-page checks were added beside it: every class the rendered page applies is
found by the scanner, and every one of those that compiles to a utility survives
into the CSS that page carries. HTML parity on the fixture is still asserted, with
exactly one node removed from each side — the `<link>` there, the leading
`<style>` here — named as a single-purpose exception rather than a normalizer.

`finalizeHtml` now takes the CSS as an **ordered list and makes one insertion**.
That is forced: two insertions before the same anchor keep their order in `<head>`
and reverse it in the fallback that prepends. It also fixes an old asymmetry — the
`<link>` had no fallback at all, so a page with no `</head>` used to get its scoped
rules and no stylesheet; both now follow the same head → body → prepend ladder.

A `.md` page no longer compiles the project at all. `compileProject` used to run
there for nothing but the shared stylesheet, and a markdown page has no JavaScript
graph, so **the wasm compiler is out of every markdown render**.

**The hash is gone with the file, and the reason it was not a divergence is worth
keeping.** It looked like one: `js-imported-css.ts:147` names the bundle with
`Bun.hash`, which is wyhash and has no workerd equivalent. That token turns out to
name a *virtual entrypoint* that never reaches the output. The real filename came
from `css.ts:33-40` — `Bun.CryptoHasher("md5")` over the bundle text, first 8 hex
chars — which is reproducible. `src/md5.ts` is a pure-JS MD5 held to
`Bun.CryptoHasher` across every padding boundary and the RFC 1321 vectors, and it
is still what names `?url` assets. (`crypto.subtle` was not an option: workerd
accepts `"MD5"` as a non-standard extension, Bun rejects it, so the two hosts
could not share it.)

What also still differs on `fixture-astro-hoisted-imports` is the stylesheet's
**content**. The Bun host pushes CSS imported from *outside* `src/` through
`Bun.build`, a lightningcss-shaped parse-and-reprint, and leaves CSS from inside
`src/` verbatim. In one bundle from that fixture:

```css
/* styles/local.css      — inside src/  */  color: rgb(4, 5, 6);
/* vendor/frontmatter.css — outside src/ */  color: #0a141e;
```

Identical CSS, different output, decided by where the file lives. The isolate has
no CSS parser to reprint with, so it emits every file verbatim. The framing —
`/* path */` labels, file order, separators — is byte-identical to Bun's; only
the declarations inside the reprinted files differ, plus the still-missing
hoisted-script CSS block. Recorded in `project-css.ts`, not normalised away.
(Since the fork above, that fixture's bundles also no longer line up one-to-one:
per-root chunks are gone, so a page's out-of-tree CSS is one bundle in import-graph
order rather than several keyed by root.)

That asymmetry in the Bun host looks worth questioning on its own terms: both
forms are valid CSS with identical semantics, but the same file yields different
bytes depending on which directory it sits in.

### Dynamic routes

All three kinds render. `tests/fixture-on-demand-routes` encodes the distinction
and its comments explain why it matters:

| kind | behaviour | reference for parity |
|---|---|---|
| `getStaticPaths()` | only the paths it returns; anything else 404s | `pletivo build` |
| `export const prerender = false` | rejected: the host has no HTTP SSR response contract | **none exists** |
| neither | stays a 404 | — |

**One constraint decided the shape.** `build.ts:355-385` calls
`mod.getStaticPaths({ paginate })` on the imported page module, and its own
comment explains that param sets are JSON-safe *because* props are not:
collection-backed routes carry `render()` methods in props. Params can cross the
isolate boundary; props can never. So it is one call — the host asks for
*pathname X of route file Y* and the isolate does import → `getStaticPaths` →
match → render internally. `projectPaths()` is the separate enumeration call for
a preview index or a sitemap, returning params only, which is exactly the
JSON-safe half. `createPaginate` went into the runtime bundle.

**Params cross as `[name, value|null]` pairs, not as an object.** `undefined` is a
real param value — `matchRoute` returns `{page: undefined}` for the first page of
a `[...page]` route — and `JSON.stringify` drops the key outright, so an object
would arrive as `{}` and match the wrong `getStaticPaths` entry. Verified:
`JSON.parse(JSON.stringify({page: undefined}))` has no `page` key at all.

`packages/workers/test/fixture-dynamic-routes` is collection-free (a plain data
module) and its props carry a function, so the byte comparison covers the exact
non-serializable shape that forced this design. 8/8 byte-identical against
`pletivo build`, in workerd and on Bun.

Isolate reuse survives: route and params ride in the request, never in the module
map, and a test asserts one bundle across a static route, three dynamic ones and
an enumeration call.

**Current decision:** `prerender = false` is rejected before rendering or path
enumeration. Supporting it would require a versioned request/response protocol for
status, headers, cookies, body, and request context. The current static protocol has
none of those semantics, so returning HTML would be a false success.

### Content collections

`content/collection.ts` was 817 lines in the Bun host. The host-agnostic 859 —
types, the loader protocol, `glob()`, `defineCollection`, `initCollections`,
`getCollection`/`getEntry`/`render`/`reference`, schema validation, the store —
now live in `@pletivo/core/content/collection` behind an explicit `ContentRuntime`
created from a `ContentHost`. 167 lines stayed on the Bun side: `Bun.Glob`,
`Bun.file`, `fs`, the config-file lookup, the `image()` probe, the `.mdx` import.
One implementation, two hosts.

The scan **sort** moved into the seam's contract rather than staying an
implementation detail: `Bun.Glob.scan()` yields in filesystem order, which
differs between ext4 and tmpfs, so a virtual-map host has to match it. That is
now stated on `ContentScan.files`.

**Config modules need no rewriting.** `astro:content`, `astro/loaders` and
`pletivo/content` all already resolve on the Bun host, and the Workers host
accepts the same three. Nothing new is forced on a project written for Bun.

**Files reach the isolate over a loopback binding, not in the module map.**
`globalOutbound: null` stays — the two are independent, so the isolate is still
cut off from the network while `env.PLETIVO_CONTENT` answers `scan`/`read`.

That choice buys isolate reuse and invites exactly one failure, so both are
tested. Editing content can re-render with the same `ProgramHash`; request-local
content bytes do not identify executable code. The collection state is owned by
the request's `ContentRuntime`, while the host-controlled capability generation
invalidates isolates when the binding authority changes.

And every binding call carries a per-render ref rather than reading a "current
project", closed in a `finally`. Not defensive coding: measured in workerd, a
mutable module global handed the slower of two overlapping requests the faster
one's bytes.

### What is left

Endpoints, islands, hoisted-script bundling, and real HTTP SSR. **Islands specifically: this host
ships no client bundle and emits no hydration script.** A `client:*` directive
renders the `<pletivo-island>` wrapper and its serialized props and stops there —
the runtime bundle does not even export the island registry, so the host cannot
learn which islands a page used. That is what makes the CSS model's known hole
theoretical for now, and what will end it.

Vite's import suffixes are no longer among them: `?raw`, `?inline` and `?url` are
answered as of the second dogfood run, which is where they turned up — 28 of that
site's 29 routes stopped on `?raw` alone. `?inline` follows the Bun host (the
file's text) rather than Vite (a data: URI); the two hosts agreeing is worth more
than matching Vite here, but it is a divergence, not an oversight. See
[022](022-dogfood-ssr-workers.md) items 3 and 4.

`tests/fixture` still cannot run here, and collections are no longer the reason:
its pages use extensionless imports (`import Layout from "../components/Layout"`,
§7 edges) and islands. `content-formats` needs `.mdx`, which the isolate has no
renderer for and says so by name. Also absent from collections: `image()` schemas
(no filesystem), and the glob matcher is a re-implementation — `**`, `*`, `?`,
`{a,b}` and dotfile exclusion only, so extglob and character classes can match
differently than `Bun.Glob`. `generateId`'s `base` URL is rooted at the file map
rather than at the machine.

Still missing from CSS specifically: the out-of-`src/` reprint above,
hoisted-script CSS, `.scss`/`.sass`, and CSS modules. And the browser cache a linked stylesheet
would have given across pages — given up knowingly, because in a workspace an agent
writes to continuously that cache is invalidated on every write anyway
([023 §5](023-live-workspace-architecture.md)).

Two smaller edges: extensionless imports (`import x from "./foo"`) are not
resolved, since `resolveSpecifier` needs an exact file-map key — common in TS
projects, and it fails loudly as an unresolved module. And a `.js`/`.mjs` file in
the map is carried verbatim, so a mis-named TypeScript file still reaches the
isolate; that is the one path `typescriptSuspects` can still fire on.

Two mechanical constraints: the whole project is still recompiled per request (only
the *isolate* is content-addressed, by module-map hash) — the CSS no longer forces
that, but nothing prunes it yet, see [023 §4](023-live-workspace-architecture.md) —
and file-map keys must not contain `..`, since `resolveSpecifier` drops a climb past
the root.

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
