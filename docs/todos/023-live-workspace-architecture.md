# 023 — The live workspace: SQLite FS, lazy compile, inline CSS

**Priority:** S-tier
**Status:** In progress — the store and the Durable Object serve a live workspace; compilation, CSS, assets, and Loader identity now use the explicit host seams described in §10.
**Area:** Workers host / architecture

Where `@pletivo/workers` goes once the project stops being a snapshot handed in with
the request and becomes a **workspace an agent writes to while the site is being
served**. That is the shape Roj needs: the same file store carries the sources, and an
agent edits a component or adds a content page between two renders.

Supersedes the framing in [020](020-workers-integration-phase.md), which treated the
site artifact as a build output. It is not one. It is a cache.

## 1. What actually changes

`pletivo prepare` freezes two things that a live workspace can change:

- the result of running `astro.config.*` and every integration's `astro:config:setup`
- npm, bundled per package by `Bun.build`

Both are derived from files. In a workspace `astro.config.mjs` is a file the agent can
edit, and so is `package.json`. A frozen snapshot of them is wrong by construction —
not slow, wrong.

The size problem is a symptom of the same thing. Measured:

| | config + vendor map | modules |
|---|---|---|
| the static dogfood site | 1 kB | 0.1 MB |
| the SSR dogfood site | 1 kB | **12.4 MB** |

The 12.4 MB is what made a request cost **6.3 s before routing** — dropping `modules`
from the payload took a 404 from 6 325 ms to **49 ms**. But shrinking it is not the
point. The point is that it should not be a thing that gets built and shipped at all.

**The model:** the workspace is the source of truth; everything derived — vendored npm,
the config snapshot, compiled modules — is a cache *inside* the workspace, invalidated
by the writes that produced it. Exactly the shape `node_modules/.pletivo/cache/`
already has for `build --incremental`.

## 2. The decision: compile runs inside the DO that owns the file store

Taken deliberately, over "compile in a worker beside the DO, read over RPC".

`kompjutr` exposes a node:fs-shaped facade over SQLite in a Durable Object. Inside that
object `SqlStorage` is synchronous, so reading a file is
about as expensive as a map lookup. Beside it, every read is an RPC hop — and even the
14 files a page actually needs would be 14 round trips, which would force batched
reads (one RPC, a set of paths) and a lazier design than the one below.

**What it costs:** the compile occupies the DO's thread, so one project is one render
thread. Fine for a preview or an agent workspace, which is one user. A throughput
ceiling for a public site with real traffic — see §8.

## 3. What that decision buys: the cache stops needing hashes

This is the part worth spelling out, because it was not the reason for the choice.

A compile cache in a stateless host worker has to be a best-effort `Map` keyed by
`md5(path + source)` — 24 ms of hashing per request for 700 files, plus a key that has
to fold in the compiler version to stay honest across a deploy.

Put the compile in the DO that owns the file store and none of that is needed. The
cache is keyed by path and holds the source it was built from; a file is unchanged when
that source compares equal. No digest, no key, no staleness window. The cache lives
where the files live, and one host is one project is one compiler, so the compiler
version cannot drift underneath it either.

**Correction, recorded because the earlier text got it wrong and the mistake reached
three files.** This was first written as an argument about *identity*: the DO is the
single writer, so an unchanged file comes back as the same string object and `===` is a
pointer compare rather than a hash. The premise is false — `===` on two strings compares
their contents, and JavaScript gives no way to observe string identity at all. So an
equal source hits whether or not the store returned the same object, and the cache is
correct even for a store with no revision gate; such a store simply pays a memcmp per
file, which is still far below the 24 ms above.

What the revision gate actually buys is the **read**: an unchanged workspace costs one
`filesystem.rev()` lookup instead of a walk of the tree and a re-read of every
file. That is worth having on its own, and it is what `workspace-store.ts` tests.

Invalidation is therefore the source comparison and nothing else. An explicit
`cache.delete(path)` on write would need a seam the store does not have — it is
read-only, and the DO writes through the workspace — and a missed delete is a stale
bundle, which comparing the source can never produce.

What remains true: a DO can be evicted, so the cache must be rebuildable from the
workspace. That is a cold start, not a correctness problem.

## 4. Lazy reads make pruning mandatory rather than optional

Today `compileProject` iterates the whole map, and so do `projectRoutes`,
`hasStylesheet` and the CSS pipeline. That is free only because the map is already
materialised in memory. Against a real file store it stops being free, and the design
has to ask for what it needs.

Which is the change worth making anyway. Measured on the static dogfood site:

- **109 modules compiled per request**
- **a page reaches a median of 14** (min 11, max 17, over 38 pages)

So ~87 % of every compile is for modules the requested page never touches. And the
compile is where the time is — of the hot loop, 72 % is the Astro wasm transform, 26 %
sucrase, 2 % `collectSpecifiers`, and **2 ms** is `rewriteImports`, the one stage that
depends on the file *set* rather than on one file's bytes.

Route matching needs a directory listing of `src/pages`, not the files. Everything else
follows the page's own import graph.

## 5. CSS: compile Tailwind from the rendered HTML, inline it, link nothing

The current model — one project-wide stylesheet — is what forces the whole-project
graph: one sheet needs every route's CSS imports, which needs every module compiled.
The CSS decision and the compile cost are one decision.

`pletivo dev` does the same thing (`/__styles.css`, whole project), so dev is not an
alternative model. Astro has two: per-module virtual URLs in dev
(`X.astro?astro&type=style&index=N&lang.css`), page-entry-set chunks in build.

**The chosen model is neither: scan the rendered HTML, the way the Tailwind CDN does.**
`compiler.build(candidates)` takes a plain array, so the source of candidates is the
only thing that changes. Measured on the static dogfood site, 5 pages rendered through the Workers
host:

| candidates from | count | CSS | build |
|---|---|---|---|
| `src/` scan (today) | 22 657 | **83.8 kB** | **190 ms** |
| rendered `/` | 1 188 | 50.1 kB | 29 ms |
| rendered `/cookies/` | 961 | 39.5 kB | 25 ms |
| rendered `/faq/` | 1 275 | 43.3 kB | 21 ms |
| rendered `/kontakt/` | 1 179 | 44.3 kB | 19 ms |
| rendered `/o-virivkach/` | 1 223 | 46.0 kB | 30 ms |

Roughly half the bytes and a sixth to a tenth of the time. **21 348 of the 22 657
source candidates are unused across those five pages.**

**The known hole, accepted rather than measured:** a class that only appears once client
JS runs — `classList.add('hidden')`, a `class:list` branch this render did not take — is
not in the HTML. A source scan finds it because the string literal is in the file. So
the scan input is *the rendered HTML plus the client bundles that page ships*, which the
host already knows. The measurement above cannot show this gap at all: the static dogfood site has no
islands. Do not read the table as evidence that the hole is small.

**Why inline is acceptable here, when it usually is not:** the one real argument for a
linked stylesheet is cross-page browser caching, and in a workspace an agent edits
continuously that cache is invalidated on every write. The argument evaporates in
exactly the scenario this is built for.

What is left after this: plain `.css` files (reachable from the page's own graph) and
scoped `<style>` blocks (already inline, per page, ordered by `page-css.ts`). **Nothing
needs a whole-project graph any more.**

## 6. npm: prebundle on a container, write into the workspace

The vendoring logic in `prepare/vendor.ts` does not need to change — `Bun.build` per
package, entry points generated from the names actually imported, is right. What changes
is where the output lands: `node_modules/.pletivo/vendor/<name>.js` **in the file
store**, with the 1 kB specifier → filename map in the config cache. The host reads a
vendored module when it first resolves to it, the same way it reads a source file.

A container is the right place to run it: resolution needs a real npm tree, and native
packages are what refused to bundle at all
([022](022-dogfood-ssr-workers.md) §6). The trigger is a write to
`package.json`, not a build step.

Rejected: doing node resolution directly over the SQLite FS in the host. Resolution
itself is only file lookups and would work, but CJS → ESM still needs a bundler, which
is the part that cannot run in an isolate.

## 7. config: re-run it, do not freeze it

Run `astro.config.*` and the integration hooks in a dynamic Worker, cache the resulting
Artifact V2 prepared site keyed by the config files and `package.json`, and invalidate on write.

`pletivo dev` already solves this problem and its solution says why this is cheap here:
the child process exits with `RESTART_EXIT_CODE` (75) when the config changes, because
the astro host is built once per process and Bun plugins cannot be unregistered. On
Workers, "restart the process" is a new isolate — **33 ms, measured**. The thing that is
expensive enough on Bun to justify a supervisor is nearly free here.

`astro:config:setup` is already re-entrant, and has to be: a thrown hook is retried on
every file change, and the retry context dedupes `injectRoute` / `injectScript` /
`updateConfig`. That work is done.

## 8. Prerequisites

Today nothing here runs in a Durable Object: the host is a stateless `fetch` worker
handed the whole project in the request body (`packages/workers/example/src/index.ts`).
So "the logic lives in the DO" is the change this document proposes, and the question
was whether the platform permits it.

**It does. Verified locally**, `wrangler dev` with `worker_loaders` and a
`new_sqlite_classes` DO, all three claims in one request:

| claim | result |
|---|---|
| a DO reads its own `SqlStorage` synchronously | yes — §2's whole premise |
| `ctx.exports` is reachable from a `DurableObjectState` | yes, and the entrypoint factory is callable |
| a DO calls `env.LOADER.get()` and reaches the isolate | yes, HTTP 200 from the dynamic Worker |

The third matters more than it looks: the isolate called *back* into the DO's worker
through a `ctx.exports` binding the **DO** handed it. That is the same loopback content
collections use today (`content-files.ts`), so the one part of the render that needs the
file store from inside the isolate keeps working when the host is a DO.

Caveat: local workerd, not a deployed Worker. Worker Loaders are in open beta, and
whether a deployed DO namespace may hold the binding is a separate question from
whether workerd allows it.

One prerequisite stays open, and it is not a capability question:

- **Is one render thread per project acceptable?** §2 buys cheap reads with a
  throughput ceiling. For a preview or an agent workspace that is the right trade. For
  a public site it is a decision to make on purpose, not to discover.

## 9. What this re-ranks

- **The per-file compile cache stays**, and gets simpler — §3. It is what makes the
  agent's edit-render loop cheap.
- **The whole-project fast path is pointless** once the compile is pruned to the page:
  there is nothing left to short-circuit.
- **[PR #23](019-css-chunking.md) stays a `pletivo build` change** and should not be
  ported to the Workers host. A static build knows every page in advance and chunking is
  a clean win there; an on-demand render does not want to know.
- **[020](020-workers-integration-phase.md) step 5** (`markdown.rehypePlugins` as live
  functions) gets easier, not harder: a plugin is a module in the workspace, and the
  isolate can import it. The reason it was the fragile part was that a function cannot be
  frozen into an artifact.

## 10. What exists

The seam and the Durable Object. Three objects, composed rather than inherited, so none
of it needs a Durable Object under it to be tested:

| | |
|---|---|
| `src/project-store.ts` | `ProjectStore` — one revision-coherent snapshot of source text and its demand-driven `ProjectAssetsView` |
| `src/project-host.ts` | `createProjectHost` — route, render, serve the generated assets, turn the throws into status codes |
| `src/asset-port.ts` | `ProjectAssetsView` — `info(source)` and `resolveOutput(path)` without an eager project-wide asset scan |
| `src/workspace-store.ts` | `createWorkspaceProjectStore` over `kompjutr`'s SQLite filesystem, typed structurally so this package depends on none of it |
| `example-playground/` | the production-correct Durable Object workspace, with an editor in front of it |

Verified under `wrangler dev` against a real workspace: a component written into SQLite
changes the next render, scoped CSS included, with no build step between the two. The
public `filesystem.rev()` gate holds: two reads of an unchanged workspace
return the same object, so the tree is walked once rather than once per request.

Then verified on real Cloudflare (`pletivo-playground.contember.workers.dev`, account
Contember), which is where the next two subsections come from — **neither is visible under
`wrangler dev`, and both bit on the first deploy.**

### 10.1 A Durable Object and a `WorkerEntrypoint` are two isolates

Measured with two lazily-minted module UUIDs, stable across requests: the DO reported
`a3be2502…`, the entrypoint in the same script `db5c0201…`. One script, two module
records, two of every module-level `const`.

That breaks the obvious content wiring. `ContentFiles` hands out a `ref` per render and
keeps the open set in the instance; if the DO opens the ref and a `WorkerEntrypoint`
answers for it, the answering side has a different `ContentFiles` and every page with a
collection is a 500 (`no open project for content ref "r9"`). A page without one renders
fine, so the failure looks like a content bug rather than a topology one. Miniflare puts
both in one isolate and shows none of it.

**The binding has to be the thing that owns the files** — a stub to the Durable Object
itself, which `content-files.ts` already names as a valid implementation. The calls are
re-entrant (the DO is awaiting the render that makes them) and that is fine: they touch
no storage, and a DO accepts events while it awaits I/O.

`example/` deliberately does not expose content collections. It is request-scoped and
has no owner that can keep a content handle alive across the Loader callback. The
playground's DO-self binding is the sole reference topology for content.

### 10.2 The Loader cache outlives a deploy

`env.LOADER.get(id, factory)` runs the factory on a cache miss. The executable program has
its own `ProgramHash`; the Loader key additionally covers the host ABI, compatibility
settings, tenant, capability generation and immutable factory policy. Before those were
separate identities, a deploy could leave old isolates holding the old binding object.

**Anything the host puts in a dynamic Worker's `env` is pinned at isolate creation.**
Changing it requires the caller's `capabilityGeneration` or the host ABI to change; a
deploy alone is not a capability identity. The playground derives the tenant from the
stable Durable Object id and names its DO-self binding generation explicitly.

**What has landed and what remains**, in dependency order:

1. ~~**Prune the compile to the page** (§4)~~ — **done.** `compileProject` takes
   `entries` and compiles only what their import graphs reach; `renderPage` passes the
   one page it matched, `projectPaths` passes the dynamic routes it is about to
   enumerate. Naming is lazy and doubles as discovery — `resolve` was already the single
   place that decides a module belongs in the bundle — so the queue is drained with an
   index cursor, because `resolve` runs inside `rewriteImports` and appends to it
   mid-walk. On `examples/basic` (1 521 files, 9 executable pages) a render went from
   **17 modules to a median of 4** (min 2, max 5). Absent `entries`, every module-shaped
   file is still compiled, which is what a full build wants.

   Two seeds have no static importer and had to be made explicit. The content config is
   one: nothing imports `src/content.config.ts`, the isolate's prelude reaches it through
   a thunk, and it used to be in the bundle only because everything was — so `resolve`
   now seeds it the moment something touches the content API, *from inside the walk*,
   because it has a graph of its own. `findContentConfig` probes eight paths against
   `srcDir` instead of scanning every key, which is what a lazy file store needs. The
   `astro:assets` sources are the other, and they got more precise rather than less: the
   old whole-map substring scan gave them to any project that merely mentioned the string
   in prose, and they are now merged the first time `resolve` is actually asked for them.
   Injected scripts needed nothing — they are code strings written into the HTML, never
   modules.

   **A behaviour change, deliberate:** a file no rendered page reaches is never read, so
   a syntax error in it never surfaces. It used to fail every render of the project.
   Right for an on-demand renderer — `pletivo build` on the Bun host still compiles
   everything — but a semantic change, and
   `test/compile-project.test.ts` asserts it rather than leaving it to be discovered.

   **Isolate fragmentation, the price.** One project was one module map was one isolate,
   whichever page you asked for. Now each page gets its own, up to one per page, plus one
   for path enumeration — and `x-pletivo-bundle` stops being a project identity. Against
   that: the compile is what a render pays for, and invalidation gets *finer*. Today any
   write anywhere moved the whole-project hash and every page went cold, pages that
   cannot see the edited file included; now only the pages that reach it do. What does
   not improve is a shared layout — 38 pages hold it in 38 module maps, and editing it
   cools all 38 exactly as before. A fresh isolate is 33 ms (§7), so the trade is a
   ~4–8× smaller compile against occasionally paying that once more.
2. ~~**Cache compiled modules per file** (§3)~~ — **done.** `ProjectHost` owns one
   bounded compile cache. Entries key by logical file and compare source plus module
   kind; resolution and file-set effects are replayed on every assembly. This makes the
   shared-layout case above cheap without letting cached resolution outlive an artifact
   or workspace revision.
3. ~~**CSS from the rendered HTML** (§5)~~ — **done.** `pageStylesheet` uses the
   compiler's canonical resolved style graph, inserts Tailwind at its consumed closure's
   cascade position, and emits every stylesheet at most once. Tailwind candidates come
   from decoded HTML class attributes plus injected script bodies. `finalizeHtml` inlines
   the result safely; nothing links a stylesheet and `renderPage` returns no CSS asset.
   A `.md` page no longer compiles the project at all. The two hosts' HTML forks here
   permanently; `docs/todos/016 §7` records what the replacement parity test proves and
   what it does not.
4. **npm on a container, into the workspace** (§6), and **config re-run in a dynamic
   Worker** (§7). Until then a project with npm dependencies still needs an artifact —
   `artifactPath` reads one out of the workspace, which is a file an agent can replace,
   but `pletivo prepare` still has to produce it somewhere else.

The measurements on the demo project (30–70 ms a render) say nothing about any of this:
it has five files. The numbers that matter are still those from the static dogfood site in §4.
