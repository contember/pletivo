# 020 — Astro integrations in the Workers host

**Priority:** S-tier
**Status:** Design only — no code written
**Area:** `@pletivo/workers`

**Status:** design only, no code written.
**Scope:** how `@pletivo/workers` gets what `astro:config:setup` produces, for the two
sites in `docs/todos/017` (the static dogfood site) and `docs/todos/018` (the SSR dogfood site / nua).


> **Verified independently before adopting:** bare specifiers pass through
> `resolveSpecifier` unchanged and nothing in the module map answers them, so the
> npm point below is real. The counts are higher than the design states —
> **37** files import `astro-icon/components` in the static dogfood site (not 20), 13 import
> `@nuasite/components` in the nua site.

---

## 0. Recommendation in one paragraph

Run the whole config/integration phase **ahead of time on Bun**, in a new
`pletivo prepare` command that reuses `initAstroHost()` unchanged, and ship its
finished product into the Worker as a two-part artifact: a **JSON document** of
everything that is data (config fields, injected scripts as strings, injected route
patterns, redirects, virtual-module bindings) and a **module map** of everything that
is code (frozen virtual-module bodies, bundled npm packages, injected-route
entrypoints, the markdown plugin bundle). The Worker never runs an integration; it
consumes the artifact the way it already consumes `GENERATED_MODULES` and
`TailwindStylesheets`. The decisive reason is not elegance — it is that
`astro:config:setup` on both real sites reads the filesystem hard (the static dogfood site's own config
does `readdirSync` over 93 YAML files at module scope; nua's `content-index.mjs` reads
1370 files and writes a generated module *inside the hook*), so the phase cannot run
in an isolate at all without a second re-implementation seam of the kind
`docs/todos/016 §1` already warns about. Freezing costs a redeploy when the
*integration set* changes, and nothing when content, `.astro`, `.tsx`, `.md` or CSS
changes — which is exactly the boundary that already exists, because an agent editing
a site inside a Durable Object cannot `npm install` either.

---

## 1. The constraint

A Worker Loader isolate has:

- no filesystem — `@tailwindcss/oxide` and `@astrojs/node`-shaped code cannot run;
- no npm resolution — `resolveSpecifier` (`packages/workers/src/rewrite-imports.ts:108`)
  returns bare specifiers unchanged, and the Loader then fails on them;
- no `eval` / `new Function` — the only way to execute generated code is a module map
  assembled by the host worker (`render.ts:642`);
- `globalOutbound: null` (`render.ts:655`) — no network, deliberately.

Everything the isolate can ever run is a string in `modules: Record<string, string>`,
content-addressed by `bundleHash` (`render.ts:948`). Everything else has to arrive as
JSON in the request body or as a binding in `env`.

Integrations are arbitrary npm packages that do arbitrary Node work. There is no
version of "run integrations in the isolate" that does not first require someone with
a filesystem and npm to have chosen and bundled them.

**Two blockers, not one.** Integrations are the stated problem, but for both target
sites the *first* blocker is plainer: their `.astro` files import npm packages —
`astro-icon/components` in 20 the static dogfood site files, `@nuasite/components/Image.astro` in 13
nua files — and the Workers host has no notion of node_modules at all
(`packages/workers/test/*` all skip it explicitly). Any design that ships integrations
must ship a vendor module set too, and the same prepare-time step produces both. This
is why the build order below starts with vendoring, not with hooks.

---

## 2. What `astro:config:setup` actually produces, and what survives serialization

Source of truth: `packages/pletivo/src/astro-host/runner.ts:199-254` (the setup
context), `runner.ts:532-594` (`applyConfigPatch`), and
`packages/pletivo/src/astro-host/vite-plugins.ts`.

| API | What pletivo does with it today | Needed at | Serializable? | Consequence |
|---|---|---|---|---|
| `injectScript('head-inline')` | `runner.ts:242` → `injectedHeadScripts`, emitted by `build.ts:1391` / `dev.ts:436` | render | **Yes** — a string, already TS-stripped by `stripTypes` at injection time | none |
| `injectScript('page')` | `injectedPageScripts` → `<script type="module">` | render | **Yes**, same | none |
| `injectScript('before-hydration')` | `injectedBeforeHydrationScripts` → emitted only when the page has islands | render | **Yes** | moot until the Workers host has islands |
| `injectScript('page-ssr')` | `build.ts:177` runs it with `new Function(code)` | build | String survives, **execution does not** — workerd has no `eval` | must fail loudly at prepare time |
| `injectRoute({pattern, entrypoint})` | `runner.ts:223-236` → `injectedRoutes`; entrypoint resolved by `require.resolve` (`build.ts:1613`, `dev.ts:1450`) | render | **Pattern yes, entrypoint no** — it is an npm/absolute path | entrypoint must be compiled into the module map at prepare time |
| `updateConfig({ vite: { plugins } })` | `applyConfigPatch:560-578` → `addVitePlugins`, then Bun `onResolve`/`onLoad` (`vite-plugins.ts:59-84`) and `materializeViteVirtualImports` (`vite-plugins.ts:114`) | render (virtual modules), dev (everything else) | **`resolveId`/`load` output yes, the functions no** | freeze the *result* per specifier; a plugin whose `load()` depends on request-time state cannot be frozen |
| `updateConfig({ vite: { resolve.alias, ssr.noExternal, … } })` | merged into `config.vite`, mostly unread by pletivo | build | Data, but pletivo ignores it | vendor bundling at prepare time must honour aliases itself |
| `updateConfig({ markdown: { remarkPlugins, rehypePlugins } })` | read by `resolveMarkdownOptions` (`packages/core/src/content/markdown.ts:52`) → `configureMarkdown` at `build.ts:144` / `dev.ts:209` | render | **No — live function values** | must be re-bundled as code; see §5.4 |
| `updateConfig({ redirects, site, base, trailingSlash, build.format, i18n, env.schema })` | merged onto `config`; read at `build.ts:229/466/746`, `routes-adapter.ts` | render | **Yes** | none |
| `updateConfig({ integrations })` | queued for setup (`runner.ts:546-557`) | config phase | N/A — resolved before the artifact exists | none |
| `addRenderer` | **no-op** (`runner.ts:215`) | — | — | already unsupported on both hosts |
| `addWatchFile` | **no-op** (`runner.ts:216`) | dev | — | meaningless without a watcher; the DO knows its own edits |
| `addClientDirective`, `addMiddleware`, `addDevToolbarApp`, `addPageExtension`, `addContentEntryType`, `addDataEntryType` | **no-ops** (`runner.ts:217-222`) | — | — | unchanged |

Later hooks, for completeness:

| Hook | Runner | Fate in the Workers host |
|---|---|---|
| `astro:config:done` | `runner.ts:327-343` | Runs at prepare time. `setAdapter` is a no-op, `injectTypes` returns a URL and writes nothing. |
| `astro:routes:resolved` | `runner.ts:374` | Prepare time can only supply *static* routes; dynamic param sets need an isolate round trip (`projectPaths`). See §7. |
| `astro:build:start` / `:setup` / `:generated` / `:done` | `runner.ts:393-487` | **No dist exists.** Sitemap, pagefind, checks, llm-enhancements, agent-summary all live here. See §7. |
| `astro:server:setup` / `:start` / `:done` | `runner.ts:346-369` | Connect middleware (`connect-bridge.ts`) — functions. Cannot be frozen. |

**The single sentence that decides the design:** the only config-phase outputs that
matter at render time are *strings, JSON, and module bodies*. Astro itself reached the
same conclusion — `SSRManifest`
(`~/projects/sandbox/astro/packages/astro/src/core/app/types.ts:53`) freezes
`routes[].scripts` as `{stage, children: string}`, `clientDirectives` as
`[name, codeString]` pairs, and `site`/`base`/`trailingSlash`/`buildFormat`/`i18n` as
data — and contains **no vite plugins at all**. Renderers and middleware, the two
things that are genuinely code, arrive through *generated import statements*
(`core/build/plugins/plugin-renderers.ts:31`), not through JSON. That data/code split
is the artifact format below.

---

## 3. What the two sites actually use

### 3.1 the static dogfood site — `<static-site>`

Astro 4.16.19, `output: 'static'`, 62 `.astro` files, 40 route files, 9 collections
(all `glob()`), 2 endpoints, no i18n, no middleware, no adapter.

| Integration | `astro:config:setup` surface | Frozen artifact serves it? |
|---|---|---|
| `astro-icon@1.1.5` | **One hook, one call.** `updateConfig({ vite: { plugins: [createPlugin(...)], ssr: { external: ['@iconify-json/*'] } } })`. Nothing else — no `addRenderer`, no `injectScript`, no component injection. | **Yes, cleanly.** Its vite plugin's `load()` returns `export default ${JSON.stringify(collections)}` — a pure JSON literal, computed once from `package.json` + `@iconify-json/lucide/icons.json` (552 kB) off disk. That is precisely a freezable virtual module. `Icon.astro` imports `virtual:astro-icon` statically and does all lookup in memory. |
| `@astrojs/sitemap@3.2.1` | **None.** Hook not declared. All work is `astro:config:done` (capture config) + `astro:build:done` (write `sitemap-*.xml`). | Irrelevant to rendering. Becomes a host-worker feature or is dropped — §7. |
| `@tailwindcss/vite` (a vite plugin, not an integration) | — | Already overridden natively (`overrides.ts:11`) and re-hosted (`packages/workers/src/tailwind.ts`). |

Beyond integrations, the static dogfood site needs:

- **`markdown.rehypePlugins: [rehypeTechLinks]`** — a *top-level import* of
  `src/utils/rehype-tech-links.ts`, which is a **pure hast transform**: no Node
  built-ins, no fs, no network, no async; its only dep is `src/utils/techLinks.ts` →
  `src/data/tech-aliases.ts`, a static table. It runs on `.md` collection bodies
  (`vybava`, `o-virivkach`, `faq`, `novinky`) via `render()`. Bundles trivially; must
  **execute**, so it is code, not data.
- **`astro-icon/components/Icon.astro`** imported in 20 files → an `.astro` file from
  node_modules, plus `@iconify/utils` → a bundled npm module.
- Config-load-time `readdirSync`/`readFileSync` over `content/shop-product/**/*.yaml`
  and a `.ts` import in `astro.config.mjs` — **cannot run in an isolate**, must run at
  prepare time on Bun.

**Verdict: a frozen artifact serves every the static dogfood site page.** The whole config:setup
surface is one JSON-literal virtual module. The only non-freezable piece is the rehype
plugin, and it is project source that bundles cleanly.

### 3.2 the SSR dogfood site — `<ssr-site>`

Astro 6.3.1, `output: 'server'` + `@astrojs/cloudflare`, 72 `.astro`, 47 route files
(8 endpoints), 11 collections / 1529 markdown files, `@nuasite/*` 0.47.5 (real
directories, not workspace links). `defineConfig` from `@nuasite/nua/config` prepends
the nua integration, which fans out to 10 integrations total.

| Integration | `astro:config:setup` surface | Frozen artifact serves it? |
|---|---|---|
| `@nuasite/nua` | `updateConfig({ redirects: {}, markdown: { remarkPlugins: cmsRemarkPlugins }, vite: { plugins: tailwindcss(), ssr.noExternal }, integrations: [5 more] })`; `injectScript('page', …)` **dev only** | Data + a plugin list. `redirects`/`integrations` resolve at prepare time; `remarkPlugins` is code (§5.4); tailwind is natively overridden. **Yes.** |
| `@nuasite/cms` | **`if (command !== 'dev') return`** — the first line. Under a build-shaped run it contributes nothing. Under dev: one `injectRoute('/_nua/preview')`, one `injectScript('page')` (a string that loads `cdn.nuasite.com/script/latest/cms-editor.js`), `updateConfig({ markdown: { rehypePlugins: [rehypeCmsMarker] }, vite: { plugins, resolve.alias, server.proxy } })`, and a **1529-file collection scan + `src/components` walk + 9 Tailwind CSS probes inside the hook** | The *outputs* freeze (a route, a script string, a rehype plugin). The *hook itself* cannot run in an isolate. **Yes for output, no for in-isolate execution.** Its `\0virtual:cms-manifest` `load()` reads a live object mutated per render — the one genuinely unfreezable virtual module in either site, and it is dev-only. |
| `site:content-index` (site-local) | Calls **none** of the injection APIs. It reads 10 content dirs incl. all 1363 articles, runs a markdown processor, and **writes `src/generated/content-index.mjs`** | **Yes, and this is the ideal case** — its output is already a real file. Prepare runs it; the generated file lands in the virtual file map as an ordinary source. |
| `astro-pagefind@1.8.6` | Reads `config.output` / `config.build.client`; **no `updateConfig`, no plugin, no injection** | Nothing to freeze. Its `build:done` spawns the pagefind Rust binary — §7. |
| `@nuasite/agent-summary`, `@nuasite/checks`, `@nuasite/llm-enhancements`, `@astrojs/sitemap@3.7.2` | **No `astro:config:setup` at all** (four of ten) | Nothing to freeze. All `build:done` — §7. |
| `@astrojs/mdx@5.0.3` | `addRenderer('astro:jsx')`, `addPageExtension('.mdx')`, `addContentEntryType`, 2 vite plugins, and a `config:done` back-channel that mutates the plugin's options object after setup | **Never runs** — `NATIVE_OVERRIDES` (`overrides.ts:17`) removes it, forwarding only its remark/rehype plugins (`runner.ts:609-627`). |
| `@astrojs/cloudflare@13.5.0` | Largest surface: `existsSync` ×13, session driver, `image` config, 5 vite plugins, 3 `addWatchFile`, and at `config:done` **`readFileSync('.dev.vars')` → `Object.assign(process.env, …)`** | Dropped today (`docs/todos/018` item 4) and should stay dropped: in the Workers host **the Worker is the runtime**, so the adapter has nothing to adapt. |

**Verdict: a frozen artifact serves the nua site's pages too** — but only because so
little of the stack touches rendering. Of ten integrations, four declare no
`config:setup`, one bails out unless `command === 'dev'`, one is natively overridden,
one is an adapter the Workers host replaces, and one writes a plain file. The
render-relevant residue is exactly five things:

1. `markdown.remarkPlugins` = `[remarkDirective, remarkListDirective]` (from
   `@nuasite/cms`, reached through `@nuasite/nua`'s `updateConfig`);
2. `markdown.rehypePlugins` = `[rehypeFigure, rehypeCdnImage, rehypeExternalLinks]`
   (three local `.mjs` files);
3. the generated `src/generated/content-index.mjs`;
4. `site`, `trailingSlash: 'never'`, `redirects: {}`, `env.schema`;
5. `@nuasite/components/Image.astro` + `flowbite`/`swiper`/`zod`/`@contember/*` — the
   vendor set.

Note (1) is the awkward one: those plugin values never appear in the site's own
config; they only exist as live functions after `@nuasite/nua`'s hook has run. §5.4
is about that.

---

## 4. Options

### Option A — frozen artifact (config phase at deploy time on Bun)

Run `initAstroHost(root, "build")` in a `pletivo prepare` step. Serialize the data,
bundle the code, hand both to the Worker.

- **Buys:** one place where integrations run, and it has a filesystem and npm — which
  is what every integration in both sites assumes. Failures land at deploy, loudly.
  Zero per-render cost. Reuses `runner.ts` verbatim. Isolate identity keeps working:
  artifact modules go into `modules`, so `bundleHash` changes when the artifact
  changes and not when content changes.
- **Costs:** changing an integration, an integration's options, `markdown.*`,
  `site`/`base`/`trailingSlash`, or the npm dependency set needs a redeploy. Any
  virtual module whose content is render-time state is out (only `\0virtual:cms-manifest`
  in either site, and it is dev-only).

### Option B — bundle a known integration set and run `config:setup` in the isolate

Pre-bundle a curated set of integrations at deploy time; at isolate start, execute
`astro.config.*` plus the hooks inside the isolate.

- **Buys:** a site's own `astro.config.*` becomes live — an agent could add an
  integration from the curated set, or change `icon({include})`, and see it without a
  redeploy. Cost is per *isolate creation*, not per request, since isolates are
  content-addressed and warm.
- **Costs, measured against the two real configs rather than in the abstract:**
  - It does **not** recover "arbitrary npm package". The set still has to be chosen
    and bundled by something with node_modules. You move *when* the hooks run, not
    *whether* the code was picked ahead of time.
  - Both configs do filesystem work at module scope, before any hook runs: the static dogfood site
    `readdirSync('./content/shop-product')` over 93 files; nua
    `readFileSync('.env.local')` + `readFileSync('wrangler.toml')` +
    `collectExcludedPaths()` walking `src/pages`. Supporting them needs an `fs` shim
    over the virtual file map — a second re-implementation seam, joining the Tailwind
    scanner (`016 §1`) and the glob matcher (`content-files.ts:134`), both of which are
    already documented as places the hosts can disagree.
  - Integration hooks do more of the same: `@nuasite/cms` scans 1529 files *inside*
    `config:setup`; `content-index.mjs` reads 1370 files and `writeFileSync`s a module
    *inside* `config:setup`; `astro-icon`'s `load()` reads a 552 kB JSON off disk.
    Every one of these would run per isolate creation instead of once per deploy.
  - `process.argv`, `process.env`, `process.versions.webcontainer`, `process.cwd()` are
    all read by real integrations in this set.
  - A broken integration becomes a 500 in preview instead of a failed deploy.
- **Verdict:** not first. It is *additive* to Option A — the artifact can carry
  `integrationModules` and the entry module can call them later — so nothing in Option
  A forecloses it. Build it only if per-site `astro.config` editing turns out to be a
  first-class agent action, and only after the fs shim exists for another reason.

### Option C — config phase in a sidecar (Container / Node service), artifact cached in KV

The host worker detects a changed `astro.config.*`, calls a sidecar that runs the
prepare step on a real Node, caches the artifact.

- **Buys:** live integration edits *without* an fs shim, because the config phase runs
  where integrations expect to run.
- **Costs:** a second runtime in the deployment; multi-second cold starts on the exact
  path that is supposed to feel live; the preview stops being "a Worker and nothing
  else", which is the property `@pletivo/workers` exists to have.
- **Verdict:** the right answer *if* live integration editing becomes a requirement.
  Note it; do not build it. It shares the artifact format with Option A, so it is a
  delivery change, not a redesign.

### Option D — do nothing, and support only integration-free projects

Honest baseline. Rejected: it excludes both target sites, and `astro-icon` alone is a
single frozen JSON literal.

---

## 5. Recommendation and implementation shape

**Take Option A.** Four decisions carry it:

1. **The config phase needs a filesystem and npm, so it runs where those exist.** Not a
   preference — measured on both configs (§4 Option B).
2. **Everything render-relevant is data or a module body.** Astro's own `SSRManifest`
   proves the split is sufficient: no vite plugins in it, renderers and middleware by
   generated import.
3. **The vendor problem and the integration problem have the same solution**, so
   solving them together costs less than either alone.
4. **Freezing draws the redeploy boundary where it already is.** An agent editing files
   in a DO cannot `npm install`; making the integration set a deploy-time property
   changes nothing it could otherwise have done.

### 5.1 What runs where

| Phase | Host | Does |
|---|---|---|
| **prepare** (deploy time) | Bun, real fs, real node_modules | `loadAstroConfig` → `initAstroHost(root, "build")` → freeze → bundle → emit artifact |
| **host worker** (per request) | workerd, no fs | reads artifact, merges its modules into `compileProject`'s output, injects scripts in `finalizeHtml`, applies frozen config to routing |
| **render isolate** (per bundle) | workerd, no fs, no network | runs pages + vendor modules + frozen virtual modules + the markdown plugin bundle |

### 5.2 Artifact format

Two files. Data is small and diffable; code is large. `PLETIVO_ARTIFACT_VERSION = 1`;
the host worker refuses a version it does not know, rather than rendering a page that
is quietly missing an integration.

```ts
// packages/workers/src/artifact.ts — types + validation, consumed by render.ts
export interface SiteArtifact {
  version: 1;
  /** sha256 of astro.config.* + lockfile + resolved integration versions. Names the artifact. */
  id: string;

  config: {
    site?: string;
    base: string;                                   // "/" today; see §7
    trailingSlash: "always" | "never" | "ignore";
    build: { format: "file" | "directory" | "preserve"; assets: string };
    i18n?: { defaultLocale: string; locales: Array<string | { path: string; codes: string[] }> };
    redirects: Record<string, { status: number; destination: string }>;
    /** astro:env schema only — never values. Secrets come from the host worker's env. */
    envSchema?: Record<string, unknown>;
  };

  /** injectScript(), already TS-stripped by runner.ts:239. Emitted verbatim. */
  scripts: {
    headInline: string[];
    page: string[];
    beforeHydration: string[];
  };

  /** injectRoute(). `module` names an entry in `modules`; the original entrypoint is kept for errors. */
  injectedRoutes: Array<{ pattern: string; entrypoint: string; module: string }>;

  /** Frozen vite virtual modules: specifier -> module name in `modules`. */
  virtualModules: Record<string, string>;

  /** Bare npm specifier -> module name in `modules`. */
  vendor: Record<string, string>;

  /** Extra project sources produced by the config phase (e.g. src/generated/content-index.mjs). */
  generatedSources: Record<string, string>;

  /** Bundle name of the markdown plugin module, or null. See §5.4. */
  markdownModule: string | null;

  /** Everything prepare saw and dropped, by integration and hook. Rendered into the preview UI. */
  diagnostics: Array<{ integration: string; hook: string; reason: string }>;
}

/** Module name -> JavaScript. Same shape as GENERATED_MODULES; merged into compileProject's map. */
export type ArtifactModules = Readonly<Record<string, string>>;
```

**Delivery.** Emit a generated TS module `pletivo-artifact.ts` exporting `ARTIFACT` and
`ARTIFACT_MODULES` — byte-for-byte the pattern of
`packages/workers/src/generated/runtime-modules.ts` and
`packages/workers/example/src/tailwind.ts`. The app's bundler embeds it; no KV fetch on
the hot path, no new loading mechanism. For a platform serving many sites from one
worker, the same JSON can live in R2/KV and be passed per request — `renderPage` takes
it as an option either way, exactly like `tailwind`.

### 5.3 New modules

```
packages/pletivo/src/prepare/
  index.ts            orchestrator; `pletivo prepare [--out <dir>]`
  freeze-config.ts    AstroConfig -> SiteArtifact["config"]  (mirror of routes-adapter.ts's reads)
  virtual-modules.ts  drain vite resolveId/load into modules
  vendor.ts           bare specifiers -> bundled modules; package .astro -> generatedSources
  markdown-entry.ts   plugin provenance + generated entry (§5.4)
  emit.ts             write pletivo-artifact.ts (+ artifact.json for inspection)

packages/workers/src/
  artifact.ts         types, version check, module merge
```

Changed, minimally:

- `compile-project.ts:298-311` — `resolve()` gains two branches next to the existing
  `JSX_IMPORT_SPECIFIER` and `isContentApi` ones: `artifact.virtualModules[resolved]`
  and `artifact.vendor[resolved]`. This is the whole vendor + virtual-module mechanism.
- `render.ts` — `ProjectOptions` gains `artifact?: SiteArtifact` and
  `artifactModules?: ArtifactModules`; `projectRoutes()` merges `injectedRoutes`;
  `renderPage` defaults `site` from `artifact.config.site`.
- `page-css.ts:118 finalizeHtml` — a fourth parameter for the injected scripts, in the
  order `build.ts:1388-1400` uses: head-inline as `<script>`, page as
  `<script type="module">`, then hydration.
- `packages/core/src/content/collection.ts` — one line: re-export `configureMarkdown`
  so it reaches `pletivo-content.js` (`scripts/build-runtime.ts:81`), where collection
  `render()` lives.

### 5.4 The one thing that cannot be frozen: markdown plugins

`markdown.remarkPlugins` / `rehypePlugins` are live function values on the config
object after setup. They must **execute**, in two places:

- collection `render()` → inside the isolate, in `pletivo-content.js`
  (`collection.ts:817` calls `renderMarkdown`);
- `.md` pages → today in the *host worker* (`render.ts:435-449`).

Prepare emits **one entry file**, `pletivo-markdown-entry.ts`, and consumes it twice:
the app's bundler imports it for the host worker; `Bun.build({ target: "browser",
conditions: ["workerd"] })` turns it into `modules["pletivo-markdown.js"]` for the
isolate. The isolate entry prelude (`render.ts:892 contentPrelude`) calls
`configureMarkdown()` with it before `initCollections`.

Generating that entry needs the plugins' *module of origin*, which a function value
does not carry. Two mechanisms, in order:

1. **Static, for plugins named in `astro.config.*`.** Scan the config source with
   `Bun.Transpiler.scanImports`; a `markdown.rehypePlugins` element that is a bare
   identifier bound to a top-level import, or `[identifier, jsonOptions]`, resolves
   directly. Covers **all of the static dogfood site** (`rehypeTechLinks`) and **all three of nua's
   local `.mjs` rehype plugins**.
2. **By export identity, for plugins an integration contributed.** Walk the ESM graph
   of `astro.config.*` and of every integration package entry (`scanImports` +
   `Bun.resolveSync`, depth-limited), `await import()` each module, and `===`-match
   every export (and every element of an exported array) against the captured plugin
   values. A match yields `{ specifier, exportName }`. This is what reaches nua's
   `cmsRemarkPlugins = [remarkDirective, remarkListDirective]`, which never appears in
   the site's own config.
3. **Explicit override, when both fail.** A `workers.markdownPlugins` field in
   `pletivo.config.*` naming specifier + export. Prepare emits a diagnostic naming the
   plugin's index and the integration that contributed it, and **fails** rather than
   silently rendering markdown without it — `docs/todos/017 §4` is the cautionary
   precedent: a plugin that runs but sees nothing produced 11 wrong anchors and no
   error.

### 5.5 Build order

Each step is independently shippable and each gets a fixture under
`packages/workers/test/` with a byte-parity assertion against `pletivo build`, reusing
the `fixture-parity.test.ts` harness.

1. **Vendor modules.** `compileProject` `resolve()` + `renderPage({ artifactModules })`,
   with a hand-written module map. No integrations involved. Fixture: one page
   importing one npm package and one `.astro` from node_modules. *This is the actual
   first blocker for both sites.*
2. **`pletivo prepare` + config freeze + injected scripts.** Smallest end-to-end slice:
   the static dogfood site's `site` / `trailingSlash`, and any `head-inline` script reaching `<head>`.
3. **Frozen virtual modules.** Drain `resolveId`/`load` at prepare time — the logic
   already exists in `vite-plugins.ts:159 materializeViteVirtualModule`, retargeted from
   `node_modules/.pletivo/virtual` to the artifact. **Unblocks `astro-icon`**, i.e. all
   43 icons on the static dogfood site.
4. **Injected routes.** Compile the entrypoint at prepare time; route, render and
   enumerate it. Unblocks nua's `/_nua/preview` and anything else that injects.
5. **Markdown plugins.** §5.4. Unblocks the static dogfood site's `rehypeTechLinks` and nua's four
   remark/rehype plugins on collection bodies.
6. **`base` / `trailingSlash` / `build.format` wiring.** `render.ts:769` hard-codes
   `BASE = "/"`; `016` already names it. Needed before either site's URLs are right.
7. **Sitemap as a host-worker feature**, built from `projectPaths()` — not as an
   integration. §7.

Steps 1–3 make the static dogfood site render. Steps 1–5 make both sites render.

---

## 6. What freezing costs, concretely

For the target use case — an agent editing a site in a Durable Object, previewing live:

| Change | Live? |
|---|---|
| Any `.astro` / `.tsx` / `.md` / `.css` / content file | **Live.** It is the file map; content does not even change `bundleHash` (it rides the binding, `content-files.ts:1-22`). |
| Adding a page, a route, a collection entry | **Live.** |
| Editing a rehype plugin's *source* (the static dogfood site's `tech-aliases.ts`) | **Not live** — it is in the markdown bundle, not the file map. Could be made live by treating project-source plugins as ordinary modules; worth doing in step 5 if it is cheap. |
| Adding an icon name to `icon({ include })` | **Not live.** *Mitigation:* freeze the whole `@iconify-json/lucide` pack (552 kB once) instead of the 45-name include list, and every lucide name works live. Per-integration mitigations like this are usually available and worth taking. |
| Adding/removing an integration, changing its options | **Redeploy.** |
| Changing `site`, `base`, `trailingSlash`, `markdown.*`, `redirects` | **Redeploy.** |
| Using an npm package not in `vendor` | **Fails.** This, not integrations, is the real boundary. |

**Nothing becomes impossible; one thing becomes slower.** Prepare is a Bun process with
npm access, so it cannot run in the DO — but it also could not have run there before,
because the DO has no node_modules. The set of things an agent can change without a
human is unchanged by this design.

---

## 7. What remains unsupported

Listed so nobody re-derives them. Each should appear in `artifact.diagnostics` at
prepare time rather than being discovered at render time.

**Cannot work at all in the isolate:**

- `injectScript('page-ssr')` — `build.ts:177` needs `new Function`. Prepare must fail
  loudly, not drop it.
- `astro:server:setup` and every connect middleware (`connect-bridge.ts`). For nua this
  is the whole `/_nua/cms/*` API, the media upload, the local admin sidecar, and
  llm-enhancements' `.md` variant serving. **Visual editing does not work under the
  Workers host.** The CMS *editor script* can still be injected (it is a frozen string
  pointing at `cdn.nuasite.com`); the API it talks to cannot.
- `\0virtual:cms-manifest` — its `load()` serializes a live object mutated per render.
  Dev-only, so it costs nothing at build shape, but it is the concrete example of a
  virtual module that is not freezable.
- Vite `transform` hooks — the Workers host has no per-module transform chain;
  `bundleVirtualEntry`'s chain (`vite-plugins.ts:292`) is Bun-only. `@nuasite/cms`'s
  `cms-array-transform` is the affected one.
- Anything at `astro:build:generated` / `astro:build:done` that writes to `dist` —
  there is no dist. That is `@astrojs/sitemap`, `astro-pagefind` (which also spawns a
  Rust binary), `@nuasite/checks`, `@nuasite/llm-enhancements`, `@nuasite/agent-summary`
  (which writes a cwd-relative `AGENTS.md`), and nua's `_redirects` merge. If any of
  these matter for preview, they have to be re-homed as host-worker features — sitemap
  is the easy one, since `projectPaths()` already returns exactly what it needs.

**Not supported today for unrelated reasons, and the artifact does not change that:**

- **Network from a rendered page.** `globalOutbound: null` (`render.ts:655`). The nua
  site's SSR pages fetch the live Contember API; under the Workers host they cannot.
  Supporting it means either dropping the isolation property or adding a fetch binding
  alongside the content binding — a separate design, and the content binding is the
  precedent for how to do it.
- **`astro:env` secret *values*.** The schema is data and freezes; values must come
  from the host worker's `env` through a binding, never from the artifact.
- Islands / `client:` directives, endpoints, hoisted-script bundling, `.mdx`,
  `image()` collection schemas, `.scss`/`.sass`, CSS modules — all `016 §7` "what is
  left", untouched by this design. `before-hydration` scripts are moot until islands
  land.
- `addRenderer`, `addWatchFile`, `addMiddleware`, `addClientDirective`,
  `addDevToolbarApp`, `addPageExtension`, `addContentEntryType`, `addDataEntryType` —
  no-ops on the Bun host today (`runner.ts:215-222`); they stay no-ops.
- Adapters. `@astrojs/cloudflare` is dropped, on purpose: in the Workers host the
  Worker *is* the runtime. Its image service, session driver and vite plugins have no
  counterpart. `docs/todos/018 §4` should be amended to say "dropped deliberately" for
  this host rather than "silently dropped".
- `astro:routes:resolved` with *dynamic* routes at prepare time — param sets come from
  `getStaticPaths()`, which needs an isolate (`projectPaths`, `render.ts:354`). Prepare
  can supply static routes only. Any integration that needs the full route list is in
  the `build:done` bucket above anyway.
- The retry loop (`retryFailedSetup`, `setupErrors`) is a dev-server concept. A failed
  `astro:config:setup` fails the deploy; there is nothing to retry against.
