# 021 — CMS visual editing: element → source mapping

**Priority:** A-tier
**Status:** Design — one line of it verified, nothing implemented
**Area:** `.astro` pipeline / dev server / Workers host

> **Verified before adopting.** `annotateSourceFile?: boolean` exists in the
> installed `@astrojs/compiler` 3.0.1 (`dist/shared/types.d.ts:50`) and pletivo
> passes it nowhere — zero hits for it or `astro-source` across `packages/`.
> Compiling a real fixture both ways: `false` → 0 attributes, `true` →
> `data-astro-source-file="src/components/Card.astro"` and
> `data-astro-source-loc="7:19"`, with the path already project-relative. Run
> through the **Workers host's** compiler wrapper, so it holds in an isolate too:
> no filesystem, no vite, no middleware.

Research + design. No code was changed. All measurements were produced by probes run in
this scratchpad against the `@astrojs/compiler` 3.0.1 that pletivo already resolves
(`bun.lock:139`, single workspace-wide version); probe scripts are listed in Appendix B.

Absolute paths are used throughout.

- pletivo: `/home/matej21/projects/oss/pletivo`
- nuasite source: `/home/matej21/projects/contember/nuasite`
- Astro checkout: `/home/matej21/projects/sandbox/astro`
- real site: `<ssr-site>`

---

## 0. Recommendation in one paragraph

Do **not** invent a new mapping format. Astro's `data-astro-source-file` / `data-astro-source-loc`
is not a "dev-only vite transform" at all — it is a single boolean option on `@astrojs/compiler`
(`annotateSourceFile`), the attributes are baked as literal text into the generated `$$render`
template literal, and pletivo already calls that exact compiler with that exact `filename` on both
hosts. Turning it on is a one-property change at two call sites and it works unchanged in a static
build, in `pletivo dev`, and inside a Worker isolate, because nothing about it needs a filesystem,
a vite server, or connect middleware. Keep Astro's attribute *names and format* — nua parses them
by string equality and by `split(':')[0]`, so parity costs nothing and buys instant compatibility.
Then add the two things Astro's mechanism structurally cannot do and that nua currently
reconstructs with heuristics: **`.tsx`/`.mdx` coverage** (via the JSX runtime, which is pletivo's own
code) and **component-instance identity** (via `createComponent`, which already receives the source
filename and has no equivalent in Astro). A novel compact encoding is *not* worth it — measured on a
real page, interning the path saves only ~0.6 KB gzip over Astro's naive repetition, so the encoding
is not where the cost lives.

---

## 1. What exists today

### 1.1 The important correction: the mapping is not in the DOM

The natural assumption — "the CMS reads `data-astro-source-file` off the clicked element" — is
wrong, and getting this right changes the design.

What actually ships to the browser carries only an **opaque join key**:

- `/home/matej21/projects/contember/nuasite/packages/cms/src/html-processor.ts:873`
  `node.setAttribute(attributeName, id)` — the value is `cms-0`, `cms-1`, … a plain per-page
  counter, reset every request
  (`/home/matej21/projects/contember/nuasite/packages/cms/src/dev-middleware.ts:452`,
  ``const idGenerator = () => `cms-${pageCounter++}` ``).

The real mapping lives **server-side, in a side-channel JSON manifest** served at `/<page>.json`
(`.../dev-middleware.ts:266`). The editor joins DOM → manifest by `data-cms-id`. Astro's source
attributes are an **input to the server-side marking pass only**, and are deleted before the HTML
reaches the browser:

- `/home/matej21/projects/contember/nuasite/packages/cms/src/html-processor.ts:883-885` and `:1032-1036`
  — `removeAttribute` of `data-astro-source-file` / `data-astro-source-loc`.

So `data-astro-source-file` is never *consumed in the browser* by nua at all. It is consumed by
nua's connect middleware, in Node, during an HTML rewrite.

### 1.2 nua's pipeline, end to end

Registration — `/home/matej21/projects/contember/nuasite/packages/cms/src/index.ts:406`:

```ts
'astro:server:setup': ({ server, logger }) =>
    createDevMiddleware(server, markerConfig, manifestWriter, componentDefinitions, idCounter, {...})
```

The whole marker system is dev-only: `.../packages/cms/src/index.ts:210` — `if (command !== 'dev') return`.
(Consistent with the real site: `dist/` contains zero `data-cms-id`.)

`createDevMiddleware` (`.../dev-middleware.ts:73`) installs five connect middlewares:

| # | file:line | what |
|---|---|---|
| 1 | `dev-middleware.ts:97` | serve uploaded media from disk |
| 2 | `dev-middleware.ts:135` | `/_nua/cms/*` — the edit API |
| 3 | `dev-middleware.ts:166` | `GET /cms-manifest.json` — global manifest |
| 4 | `dev-middleware.ts:266` | `GET /<page>.json` — **the per-page mapping table** |
| 5 | `dev-middleware.ts:320` | **the HTML rewriter** (monkey-patches `res.write`/`res.end`, buffers `text/html`) |

Two phases:

- **Phase 1, blocking** — `markHtmlForDev` (`dev-middleware.ts:384`, impl `:440`): parse the buffered
  HTML with `node-html-parser`, walk it, inject `data-cms-id` / `data-cms-component-id`, seed manifest
  rows with `tag` / `text` / `sourcePath` (the last one *only when Astro annotated the element*),
  strip the Astro attributes, then `res.end(transformed)` (`:395`).
- **Phase 2, background** — `enhanceManifestInBackground` (`dev-middleware.ts:514`): fill in
  `sourceSnippet`, and for every row still lacking `sourcePath`, fall back to a **content-based text
  search** over an AST index of `src/components`, `src/pages`, `src/layouts`
  (`dev-middleware.ts:635-665`, `findSourceLocation` at
  `/home/matej21/projects/contember/nuasite/packages/cms/src/source-finder/source-lookup.ts:24`).

Component-root detection — this is the part that needs Astro's attribute and nothing else
(`/home/matej21/projects/contember/nuasite/packages/cms/src/html-processor.ts:294-360`):

```ts
// A component root is detected by data-astro-source-file pointing to a component directory
root.querySelectorAll('*').forEach((node) => {
    const sourceFile = node.getAttribute('data-astro-source-file')
    if (!sourceFile) return
    ...
    // walk ancestors; if one has the SAME source file, this is not a component root
    if (ancestorFromSameComponent) return
    // nearest ancestor with a DIFFERENT source file = the invocation site
    ...
    node.setAttribute('data-cms-component-id', id)   // :351
```

It is pure string equality on the attribute value plus `split(':')[0]` on the loc
(`html-processor.ts:33-49`, `:358-360`). It never resolves, normalises, or stats the path.
`extractComponentName('src/components/Welcome.astro') -> 'Welcome'`.

The write path — `/home/matej21/projects/contember/nuasite/packages/cms/src/handlers/source-writer.ts:18`:

```ts
const filePath = change.sourcePath                      // :40
if (!filePath) { errors.push({ ..., error: 'No file path in change payload' }); continue }
const currentContent = await fs.readFile(fullPath, 'utf-8')   // :58
const { newContent, ... } = await applyChanges(...)           // :60
await fs.writeFile(fullPath, newContent, 'utf-8')             // :77
```

**The CMS edits the site's source files on disk by find-and-replace.** Not a Contember entity, not
a re-render, not an "open in editor". Canonical payload shape,
`/home/matej21/projects/contember/nuasite/packages/cms/README.md:84-104`:
`{ cmsId: 'cms-0', sourcePath: 'src/pages/index.astro', sourceLine: 42, sourceSnippet: '<h1>Original heading text</h1>' }`.

Other attributes, for completeness (all emitted by nua, all in the same `cms-N` id space):
`data-cms-markdown`, `data-cms-img`, `data-cms-bg-img`, `data-cms-styled` (`html-processor.ts:488/702/750/460`),
`data-cms-markdown-content` (from a **rehype** plugin, `.../rehype-cms-marker.ts:12`),
`data-cms-array-source` (from a **Vite `transform`**, `.../vite-plugin-array-transform.ts:113`),
`data-cms-ui` / `data-cms-disabled` / `data-cms-locked` (client-side only).

### 1.3 Astro's `data-astro-source-*`

**Producer: the Go/WASM compiler, and nothing else.** There is exactly one `transform()` call site in
the whole Astro monorepo — `/home/matej21/projects/sandbox/astro/packages/astro/src/core/compile/compile.ts:44-71`
— and the flag is at `:55-59`:

```ts
annotateSourceFile:
    viteConfig.command === 'serve' &&
    astroConfig.devToolbar &&
    astroConfig.devToolbar.enabled &&
    (await preferences.get('devToolbar.enabled')),
```

No vite plugin, no babel transform, and nothing in `packages/astro/src/runtime/server/render/*`
ever writes those strings. Astro pins `@astrojs/compiler` `^2.13.0`
(`/home/matej21/projects/sandbox/astro/packages/astro/package.json:112`); pletivo resolves 3.0.1.
Behaviour is identical across both (verified independently on each).

Emitted shape, verbatim from my probe on 3.0.1:

```
<section class="wrap astro-tb5vpudz" data-astro-source-file="/abs/project/src/components/Demo.astro" data-astro-source-loc="5:23">
```

Coverage rules (empirically established — Astro has no fixtures for this):

- Every plain HTML element, including deeply nested ones, ones inside `.map()` expressions, SVG,
  and void elements.
- **Astro components and framework components get nothing** — `$$renderComponent($$result,'Card',Card,{...})`
  is untouched. Their *slot content*, authored in the parent `.astro`, is annotated with the parent's file.
- Custom dash-tag elements get **only** `data-astro-source-file` (no loc), passed as a prop.
- `<html>`, `<head>` and elements inside `<head>` get nothing. `<body>` does.
- Only `.astro`. `.md` / `.mdx` / framework component files never pass through this `transform()`.

`data-astro-source-loc` is `"line:col"`, 1-based. The column is **the first child node's start
position**, not the `<`. Childless / void / self-closing elements fall back to their own tag-name
column. Measured (probe `probe-loc2.mjs`):

| source (line N) | loc | rule |
|---|---|---|
| `<a><b>x</b></a>` | a=`N:5`, b=`N:7` | first child is an element → that child's tag-name col |
| `<a>t<b>x</b></a>` | a=`N:4` | first child is text → text start |
| `<a></a>` / `<a/>` / `<br>` / `<hr >` | `N:2` | no children → own tag-name col |
| `<div  data-x='1' >y</div>` | `N:19` | char right after `>` |

**Value = the `filename` option verbatim, not `normalizedFilename`.** Verified by making the two
differ. Astro passes an absolute path, so Astro's attributes are absolute.

**Consumer inside Astro: exactly one** — the dev-toolbar Audit app.
`/home/matej21/projects/sandbox/astro/packages/astro/src/runtime/client/dev-toolbar/apps/audit/annotations.ts:11-12,26`
reads them into a `WeakMap`, and `:20` **`removeAttribute`s them from the live DOM**.
`.../audit/ui/audit-ui.ts:75-90` then offers "Click to go to file" →
`fetch('/__open-in-editor?file=' + encodeURIComponent(file + ':' + loc))`.

### 1.4 The coupling nobody designed on purpose

`/home/matej21/projects/contember/nuasite/packages/nua/src/integration.ts:59-62`, verbatim:

```ts
// Hide Astro's dev toolbar in dev mode.
// We cannot set devToolbar.enabled = false because Astro ties
// source file annotations (data-astro-source-file) to that flag,
// and the CMS needs those annotations to map elements to source files.
```

nua hides the toolbar with CSS + a `MutationObserver` rather than disabling it, purely to keep the
annotations flowing. Note the latent hazard: Astro's Audit app *strips* the attributes once it
initialises, so nua's rewrite is racing a feature it deliberately keeps enabled. Under pletivo this
whole hack becomes unnecessary — there is no dev toolbar and the flag would be pletivo's own.

`data-astro-source-*` is not part of any stable Astro contract. It exists to power one toolbar app.
A CMS depending on it is depending on an implementation detail — which is an argument for pletivo
exposing it deliberately, as a supported option, rather than by accident.

---

## 2. Why pletivo emits none of it

**One line: pletivo never passes `annotateSourceFile` to `transform()`, and that option is the only
thing that makes the compiler emit the attributes.**

```
$ grep -rn "annotateSourceFile" packages/    # → zero hits
$ grep -rn "astro-source"       packages/    # → zero hits
```

The information does not "arrive and get dropped", and it also does not "never arrive" — it is
**never requested**. The compiler is fully capable and is already the right version:

- `TransformOptions.annotateSourceFile?: boolean` —
  `/home/matej21/projects/oss/pletivo/node_modules/@astrojs/compiler/dist/shared/types.d.ts:50`
- `bun.lock:139` → one resolved version workspace-wide, `@astrojs/compiler@3.0.1`.

The two call sites, verbatim:

**Bun host** — `/home/matej21/projects/oss/pletivo/packages/pletivo/src/astro-plugin.ts:366-371`

```ts
const result = await transform(source, {
  filename: rel,
  internalURL: shimPath,
  sourcemap: false,
  resolvePath: async (specifier) => specifier,
});
```

**Workers host** — `/home/matej21/projects/oss/pletivo/packages/workers/src/compile-project.ts:397-402`

```ts
const result = await compiler.transform(source, {
  filename: file,
  internalURL: `./${RUNTIME_MODULE_NAME}`,
  sourcemap: false,
  resolvePath: async (specifier) => specifier,
});
```

Structurally identical, and both already pass a **project-relative** `filename`
(`rel` = `path.relative(process.cwd(), file)`,
`/home/matej21/projects/oss/pletivo/packages/pletivo/src/astro-css-order.ts:70`; `file` = the virtual
project path in the Workers graph). That is *better* than Astro's absolute path — it is exactly the
form nua's own fixtures and README use, and `source-writer` resolves it with
`path.resolve(projectRoot, filePath)` (`dev-middleware.ts:548,586`), which accepts either.

Why the attributes would survive with no other change: the compiler bakes them as **literal text
inside the static strings of the generated template literal**, and pletivo's astro shim
`render(strings, ...values)`
(`/home/matej21/projects/oss/pletivo/packages/runtime/src/astro-shim.ts:437`) simply concatenates
`strings`. There is no attribute-level processing to teach. Zero render-time cost.

### 2.1 The other two gaps behind the dogfood numbers

`docs/todos/018-dogfood-ssr-dev-server.md:83-88` reports `data-astro-source-file` 125→0 and
`data-cms-component-id` 4→0. These are one cause and two effects, plus two independent gaps:

1. **`data-cms-component-id` 4→0** — a direct consequence. `html-processor.ts:294` bails on
   `if (!sourceFile) return`. No source attribute → no component roots → the whole
   `insert-component` / `remove-component` / `add-array-item` surface is dead.
2. **Text→source degrades from authoritative to heuristic.** Phase 1 leaves `sourcePath` empty, so
   everything falls to `findSourceLocation` text search (`dev-middleware.ts:657`). Whatever it
   cannot resolve is **visibly disabled** in the UI —
   `/home/matej21/projects/contember/nuasite/packages/cms/src/editor/editor.ts:327-335`:
   ```ts
   // Without a source path, the writer has nowhere to persist text edits — lock
   // the element so it can't be typed into and the user gets told why on click.
   if (!manifestEntry?.sourcePath) { makeElementNonEditable(el); el.setAttribute(CSS.LOCKED_ATTRIBUTE, 'true') }
   ```
   This is why `data-cms-id` being present is not the same as editing working.
3. **`data-cms-array-source` never appears** — it comes from a Vite `transform` hook on `.astro`
   source text (`vite-plugin-array-transform.ts:113`). pletivo runs integration vite `transform`
   hooks in exactly one place —
   `/home/matej21/projects/oss/pletivo/packages/pletivo/src/astro-host/vite-plugins.ts:371-373` —
   and that chain lives inside `bundleVirtualEntry`, i.e. it is scoped to integration overlay
   sources. The project `.astro` loader (`astro-plugin.ts`) invokes no vite transform chain at all,
   verified by grep. So `cms-array-transform` never sees project files on either host. Independent
   of this design; array ops stay broken until a project-file transform chain exists.
4. **`data-cms-markdown-content` never appears** — it comes from a rehype plugin
   (`rehype-cms-marker.ts:12`), and per the site's own notes
   (`<ssr-site>/CLAUDE.md:356`) `pletivo dev` does
   not run `markdown.rehypePlugins`. Also independent.

Worth stating plainly: **`astro:server:setup` and connect middleware already work under `pletivo dev`.**
- `/home/matej21/projects/oss/pletivo/packages/pletivo/src/astro-host/runner.ts:355-368` runs the hook.
- `/home/matej21/projects/oss/pletivo/packages/core/src/astro-host/server-shim.ts:45-68` implements
  `middlewares.use`, and its comment says it exists because *"Nua CMS monkey-patches `watcher.emit`"*.
- `/home/matej21/projects/oss/pletivo/packages/pletivo/src/astro-host/connect-bridge.ts:103-105`
  explicitly lets middleware transform the response body.

So under `pletivo dev` the *only* missing ingredient is the compiler flag.

---

## 3. What the CMS minimally needs

Separating genuine requirement from incidental usage.

| Capability | Genuinely needed? | Evidence |
|---|---|---|
| **element → source file** | **Yes, hard requirement.** No file path ⇒ no write ⇒ element is locked. | `source-writer.ts:40`, `editor.ts:327-335` |
| **element → line** | **No.** Only used as a search hint. The writer matches on `sourceSnippet` text, not the line number. | `handleUpdate` → `applyChanges` operates on content; `sourceLine` is advisory |
| **element → column** | **No.** nua does `parseInt(line.split(':')[0])` — the column is parsed off and thrown away. | `html-processor.ts:36-38` |
| **element → component instance** | **Yes for structural ops** (insert/remove component, array items). Not needed for text/image edits. | `html-processor.ts:294-360`, `handlers/component-ops.ts` |
| **element → invocation site** (which file *uses* this component, and which occurrence) | **Yes for structural ops.** Currently derived as "nearest ancestor with a different source file". | `html-processor.ts:325-340` |
| **a stable per-element id** | Yes, but any join key works — it is generated by nua itself. | `dev-middleware.ts:452` |
| **element → Contember entity** | **No.** The only Contember touchpoint is R2 media upload. Content lives in `.astro` / markdown files. | `index.ts:480` |
| **open-in-editor** | **No consumer exists** in either tree. This is Astro's use, not nua's. | — |

**The minimum is: file, plus a component boundary.** Line is a nice-to-have; column is dead weight.

That has a direct consequence for cost — see §6.3: dropping the loc is what actually saves bytes
(+0.5 KB gzip instead of +1.9 KB), and it costs the CMS nothing it uses. But keeping `line:col` is
what preserves drop-in Astro parity and gives future consumers (an agent diffing source, an
open-in-editor affordance) something to work with. Recommendation keeps it, behind a switch.

---

## 4. Options

| # | Option | `.astro` | `.tsx`/`.mdx` | Component identity | Static build | `pletivo dev` | Worker | Effort |
|---|---|---|---|---|---|---|---|---|
| 0 | Status quo | ✗ | ✗ | ✗ | — | — | — | — |
| 1 | `annotateSourceFile: true` at both call sites | ✓ | ✗ | inferred by nua | ✓ | ✓ | ✓ | ~1 h |
| 2 | 1 + JSX-runtime annotation for `.tsx`/`.mdx` | ✓ | ✓ | inferred | ✓ | ✓ | ✓ | ~1 d |
| 3 | 2 + explicit component-instance marker via `createComponent` | ✓ | ✓ | **authoritative** | ✓ | ✓ | ✓ | ~2 d |
| 4 | Clean-sheet compact encoding (interned path + per-page manifest) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ~3 d + nua change |
| 5 | Server-side HTML rewrite computing positions (what nua does today) | ✓ | ✓ | heuristic | ✗ | ✓ | ✗ | — |

Trade-offs that decide it:

- **Option 1 is nearly free and is the whole of the dogfood gap under `pletivo dev`.** It is also the
  only option that is drop-in compatible with nua as shipped — no nuasite change at all.
- **Option 4's premise does not survive measurement.** The intuition is that repeating a 57-char
  absolute path on every element is ruinous. Raw, it is: +82% on a real page. Over the wire it is
  not: gzip collapses the repetition, and interning saves only **0.6 KB gzip** (§6.3). The entropy
  is in `line:col`, not in the path. So a bespoke encoding buys little and costs nua-side migration
  plus a permanent divergence from Astro. **Rejected on evidence.**
- **Option 5 is what nua does and is exactly what does not port.** It needs `res.write` monkey-patching
  and a Node filesystem for the AST search index. It is the reason visual editing is "structurally
  unsupported" in the Workers host. Any design that pushes work back to the compile step reduces
  dependence on it.
- **Option 3 is where a clean sheet genuinely beats Astro.** Astro annotates no component
  invocation, so nua reconstructs component roots by ancestor-diffing
  (`html-processor.ts:294-360`) in dev, and by **LCA clustering** in prod
  (`build-processor.ts:502,540-595` — the comment there literally says *"In production builds,
  `data-astro-source-file` is not available so processHtml cannot detect components. We infer them
  from the resolved sourcePath of entries"*). pletivo has something Astro does not expose: a real
  per-component boundary that already knows the filename.

---

## 5. Recommendation

**Ship Option 1 now. Then Option 2 and Option 3 as one follow-up, behind the same config switch.
Do not build Option 4.**

Reasoning:

1. The mechanism was never dev-only or vite-coupled in nature — only Astro's *gating* was. The
   attributes are compile-time literals. That single fact is what makes all three hosts work.
2. Keeping Astro's attribute names/format means nua works unmodified. nua parses by string equality
   and `split(':')[0]`; relative paths are what it already expects.
3. Measurement kills the bespoke-encoding argument. Design effort should go into **coverage**
   (`.tsx`, `.mdx`, component instances) — where pletivo can exceed Astro — not into byte-squeezing
   where it cannot meaningfully win.
4. Option 3 removes nua's two heuristics (dev ancestor-diffing, prod LCA clustering). That is the
   part worth calling a clean-sheet design, and it is additive: a new attribute alongside the
   Astro-compatible ones, which nua can adopt when convenient.

---

## 6. Implementation shape

### 6.1 Layer 1 — `.astro`, both hosts

One property at each of the two call sites, driven by one resolved boolean.

- `/home/matej21/projects/oss/pletivo/packages/pletivo/src/astro-plugin.ts:366` — add
  `annotateSourceFile: <flag>` to the options object. The Bun plugin is registered once per process
  (`astro-plugin.ts:352`), so the flag is a per-process decision, which is fine: dev / build /
  prepare are separate processes.
- `/home/matej21/projects/oss/pletivo/packages/workers/src/compile-project.ts:397` — same, threaded
  through `compileProject`'s existing options/`prepared` input.

Do **not** touch `/home/matej21/projects/oss/pletivo/packages/pletivo/src/incremental/import-graph.ts:104`
— that `transform()` output is thrown away after `scanImports`.

Cache-key hazards, both must be handled or the flag silently no-ops:

- The incremental cache (`node_modules/.pletivo/cache/`) keys compiled `.astro` output. The flag
  changes that output, so it must enter the cache key — otherwise flipping it serves stale
  un-annotated modules.
- The Workers bundle is content-addressed by `bundleHash`
  (`/home/matej21/projects/oss/pletivo/packages/workers/src/render.ts:1077`). The flag must be part
  of the compile inputs feeding that hash.

Path-agreement hazard: pletivo's `filename` is **cwd-relative**
(`astro-css-order.ts:70`, `path.relative(process.cwd(), file)`), while nua resolves against
`getProjectRoot()`. If `pletivo dev` is ever launched with cwd ≠ project root (a monorepo runner),
every `sourcePath` is wrong by a prefix. Either pin the base to the project root or document it.

### 6.2 Layer 2 — `.tsx` and `.mdx`

Astro's mechanism has no answer here; this is pletivo's own runtime, so it is straightforward.

The choke point is a single function.
`/home/matej21/projects/oss/pletivo/packages/runtime/src/jsx-runtime.ts`:

- `:143` `export function jsx(tag, props)` — **two parameters only**.
- `:198` `export { jsx as jsxs, jsx as jsxDEV }` — all three names are the *same function object*, so
  `jsxDEV`'s `key, isStaticChildren, source, self` arguments are silently discarded today.
  `grep -rn "__source|_jsxFileName" packages/*/src` → zero hits.
- `:92` `renderAttrs(props)` builds the attribute string; `:179` calls it; `:181/187/195` are the
  three `createHtml(\`<${tag}${attrs}...\`)` emission sites.

To wire it up:

1. Widen `jsx()` to accept args 3–6 and keep `jsxDEV` as a distinct export that forwards `source`.
2. Emit from `renderAttrs` (or immediately after it, so an injected attribute wins over a
   user-supplied one in a spread — TSX spreads are flattened by the transpiler before `jsx()` sees
   them, so `renderAttrs` gets a flat record and last-write wins).
3. Turn on dev-runtime output where the flag is set:
   - Bun host: project tsconfig `"jsx": "react-jsxdev"`, or a per-file transform in the existing
     `/home/matej21/projects/oss/pletivo/packages/pletivo/src/dev-ts-plugin.ts:41` `onLoad` hook
     (already scoped to project `src/`, node_modules excluded by construction). Note that plugin is
     **dev-only** — a build-mode `.tsx` annotation needs it widened.
   - Workers host: `/home/matej21/projects/oss/pletivo/packages/workers/src/transpile.ts:83-95`,
     flip `production: true` → `false`; sucrase then emits
     `jsxDEV(type, props, key, isStatic, {fileName, lineNumber, columnNumber}, this)`.
   - MDX: `/home/matej21/projects/oss/pletivo/packages/pletivo/src/mdx-plugin.ts:243-246`,
     `development: false` → `true`, which gives elements `_source` / `_jsxFileName`.
   - `/home/matej21/projects/oss/pletivo/packages/pletivo/package.json:19` currently maps
     `./jsx-dev-runtime` to the same file as `./jsx-runtime`; that mapping stays, the file just
     needs a real `jsxDEV`.

**Mandatory follow-up:** the Worker isolate does not execute `packages/runtime/src/*.ts` — it runs
the pre-transpiled string constants in
`/home/matej21/projects/oss/pletivo/packages/workers/src/generated/runtime-modules.ts`. Any runtime
edit requires `bun packages/workers/scripts/build-runtime.ts`, and
`packages/workers/test/runtime-modules.test.ts` fails if the committed copy drifts.

Cost note: dev-runtime output allocates a `{fileName, lineNumber, columnNumber}` object per element
per render. That is a real per-render cost, unlike Layer 1's zero-cost literals. It is the reason
this layer must be behind the flag and off by default.

### 6.3 Cost in output size (measured, not estimated)

Real page: `<ssr-site>/dist/client/inzerce/index.html`,
354 elements, ~212 annotated (~40%, matching the observed 125-of-~330 under `astro dev`).

| encoding | raw | gzip | brotli | gzip delta |
|---|---|---|---|---|
| baseline, no annotation | 37.8 KB | 10.6 KB | 9.1 KB | — |
| A. Astro's: absolute path + loc | 68.6 KB | 12.5 KB | 10.7 KB | **+1.9 KB (+18%)** |
| B. project-relative path + loc (what pletivo would emit) | 56.2 KB | 12.3 KB | 10.6 KB | +1.7 KB |
| C. scope-hash + loc, single attribute | 43.1 KB | 12.0 KB | 10.4 KB | +1.4 KB |
| D. per-page index + loc | 41.6 KB | 11.9 KB | 10.2 KB | +1.3 KB |
| E. file only, per-page index | 40.3 KB | 11.1 KB | 9.6 KB | +0.5 KB |

Read this carefully: **raw size nearly doubles, but gzip grows only 13–18%, and the whole spread
between naive and maximally-interned is 0.6 KB.** Per element, Layer 1 costs
`len(path) + ~55` bytes raw, ≈9 bytes gzipped. Compiled-module size roughly doubles for
markup-heavy `.astro` files (probe: 5,264 → 28,256 bytes for a 100-element file), which matters for
the Workers bundle budget more than for the wire.

Conclusion: annotation is cheap enough over the wire to run permanently in a **preview** deployment.
It is not cheap enough to leave on for a public production build — mostly for raw/DOM-size and
bundle-size reasons, not transfer.

### 6.4 Layer 3 — component-instance identity (the clean-sheet delta)

The gap: the compiler annotates zero component invocations, so "which component is this, and where
was it used" is reconstructed heuristically by nua in both dev and prod.

pletivo already has the boundary Astro does not expose —
`/home/matej21/projects/oss/pletivo/packages/runtime/src/astro-shim.ts:469-490`:

```ts
export function createComponent(fn, moduleId: string = "", _propagation?) {   // :475
  const wrapped = async (resultOrProps?, propsArg?, slotsArg?) => {
    if (moduleId) recordRenderedModule(moduleId);                             // :483
```

Every compiled `.astro` module is `$$createComponent(fn, '<project-relative filename>', undefined)`.
So `wrapped` is a real per-component-instance boundary that already knows the source file, already
runs once per instance, and already reports out of the isolate via `recordRenderedModule`
(surfaced at `/home/matej21/projects/oss/pletivo/packages/workers/src/render.ts:944-948`).

Design: maintain a render-scoped instance counter in the existing render-tracking
`AsyncLocalStorage` (`packages/runtime/src/render-context.ts`), and have `createComponent`'s wrapper
emit an instance marker. Two viable carriers:

- **Attribute injection into the returned HTML's first tag.** Authoritative and directly queryable,
  but the return value is already a flat string at that point, so it means string surgery on the
  first `<tag` — and it silently fails for components whose output starts with text, a comment, or a
  fragment of several roots.
- **Comment markers** `<!--pletivo:c:<moduleId>:<instance>-->` … `<!--/pletivo:c:<instance>-->`
  wrapping the output. Robust for multi-root and text-leading components, survives any DOM shape,
  and a rewriter or a client script can pair them. Costs ~40 bytes per component instance (component
  instances are 1–2 orders of magnitude rarer than elements, so this is negligible).

Recommend the **comment-marker** form. It is the only one that is correct for all component shapes,
and it gives nua's `insert-component` / `remove-component` a real anchor instead of an inferred one.
`renderComponent`'s `_displayName` argument (`astro-shim.ts:532`) is currently discarded and carries
the component's local name — worth including in the marker.

This layer replaces `html-processor.ts:294-360` ancestor-diffing and `build-processor.ts:540-595`
LCA clustering with a direct read. It is additive; nua can adopt it independently.

### 6.5 Configuration surface

One switch, three states, resolved once per process and threaded to all layers:

```
sourceAnnotations: false | true | "astro"      // default: false everywhere except `pletivo dev`
```

- `"astro"` — Layer 1 only, Astro-compatible attributes. Enough for nua as shipped.
- `true` — Layers 1–3.
- Must also be settable per-deploy for the Workers host (a preview Worker runs it on, a production
  Worker does not), and per-request is worth considering there — see §7.

Default it **on** for `pletivo dev` (matching Astro's dev default, and what nua expects) and **off**
for `pletivo build`.

### 6.6 Behaviour in each host

**Static build (`pletivo build`)**

Works, and this is strictly more than Astro can do — Astro hard-gates on `viteConfig.command === 'serve'`,
so annotations can never exist in an Astro production build (hence nua's LCA-clustering fallback).
Off by default; opt in for a preview/staging build. Note nua's marker middleware is itself dev-only
(`index.ts:210`), so a static build gets the *attributes* but no `data-cms-id` — a consumer would
have to read the source attributes directly, which the clean-sheet design supports and nua does not
currently do.

**`pletivo dev`**

Fully restores parity. The compiler flag is the only missing piece; `astro:server:setup`, connect
middleware, response-body rewriting and `injectScript` all already work
(`runner.ts:355-368`, `server-shim.ts:45-68`, `connect-bridge.ts:103-105`, `runner.ts:239-242`).
With Layer 1 alone, nua's Phase-1 `sourcePath` becomes authoritative again, `data-cms-component-id`
returns, and the `data-cms-locked` fallback stops firing for `.astro`-authored elements.
`data-cms-array-source` and `data-cms-markdown-content` stay missing for unrelated reasons (§2.1).

**Worker isolate**

Works, and this is the finding that matters most. The compiler is the same Go WASM running
in-isolate (`/home/matej21/projects/oss/pletivo/packages/workers/src/astro-compiler.ts:86-92`), the
options object passes straight through, and the emitted attributes are literal text in generated
module code. **No filesystem, no vite, no middleware is involved in producing the mapping.**

It also survives the frozen-artifact design of `docs/todos/020`. Per that doc's own table, any
`.astro` / `.tsx` / `.md` edit stays **live** — annotations ride the file map, not the artifact.
The flag is a compile input, so it belongs in the artifact/bundle hash (§6.1), meaning toggling it
is a redeploy, not a live change. That is the right granularity.

What still does **not** work in the Worker is the other half of visual editing — the **write path**.
`docs/todos/020` §7 is blunt: *"Visual editing does not work under the Workers host. The CMS editor
script can still be injected …; the API it talks to cannot."* That is correct for nua as built,
because nua's writer is `fs.writeFile` into the project source (`source-writer.ts:77`), which cannot
exist in an isolate under any design.

For the stated use case — an agent edits a site held in a Durable Object, a human previews live —
this is less damaging than it sounds, because the write target was never going to be a local
filesystem. The concrete shape that would work:

1. Layer 1+3 give the isolate-rendered HTML an authoritative element→(file, line, component) mapping,
   with no server-side rewrite.
2. Replace nua's per-page manifest middleware with a **Worker route** that reads the same virtual
   file map already in the isolate (`CompiledProject.sources`,
   `/home/matej21/projects/oss/pletivo/packages/workers/src/compile-project.ts:56-97`) — the source
   text is in memory, so `sourceSnippet` can be produced without a filesystem *and* without the AST
   search index, because the file+line is already known.
3. Replace `source-writer.ts`'s `fs.writeFile` with a DO write, then invalidate the bundle.

Cost: a nuasite-side change (a pluggable storage backend behind the existing `/_nua/cms/*` handlers)
plus a pletivo-side route that exposes `sources` + the manifest. It is not a pletivo-only fix.
Note that step 2 is *cheaper* than what nua does today — the expensive parts (HTML re-parse, AST
search index, two-phase manifest) exist precisely because the source attributes were unreliable.

---

## 7. What stays unsupported

- **Writing edits back, in the Worker host.** Structural, not a mapping problem: nua's writer is
  `fs.writeFile` into project source. Needs a pluggable backend (§6.6). Read-only visual *inspection*
  works with this design; *editing* does not, until that lands.
- **`data-cms-array-source` / array add-remove ops, both hosts.** Needs a per-module vite `transform`
  chain for project files, which pletivo does not have on either host.
- **`data-cms-markdown-content`.** `pletivo dev` does not run `markdown.rehypePlugins`, so
  `rehypeCmsMarker` never fires.
- **Elements with no source position, by construction:** anything from `set:html`, markdown-rendered
  HTML, and DOM created client-side by hydrated islands. No mechanism can annotate these; they will
  keep falling back to nua's text search, or stay locked.
- **`<html>`, `<head>` and head children** — the compiler annotates none of them. `<body>` is
  annotated. nua handles `<title>`/`<meta>`/canonical through its separate SEO processor
  (`seo-processor.ts:127,177,322`), so this is probably harmless, but it is a real hole in coverage.
- **Custom dash-tag elements** get `data-astro-source-file` only, never `data-astro-source-loc`.
  Any consumer must tolerate a missing loc.
- **Third-party `.astro` shipped as source** (e.g. `@nuasite/components` ships 6 `.astro` files and
  zero `.js`) will be annotated with `node_modules/...` paths. Those are real but uneditable; the
  CMS should lock rather than offer to write into them.
- **Precise column semantics.** The loc column is the *first child node's* start, not the element's
  `<`. Do not build an editor affordance that assumes it points at the tag.
- **Astro's Audit app strips the attributes** if it ever initialises. Irrelevant under pletivo (no
  dev toolbar), but relevant to anyone comparing outputs between the two.
- **Instance identity for `.tsx` components.** A plain function component carries only `fn.name`;
  there is no `createComponent`-style boundary. Layer 3 covers `.astro` only.

---

## Appendix A — file:line index

**nua** (`/home/matej21/projects/contember/nuasite`) — note installed 0.47.5 vs source 0.49.3 are
byte-identical for `index.ts` and `html-processor.ts`; only `dev-middleware.ts` differs by a 3-line refactor.

| what | where |
|---|---|
| `astro:server:setup` registration | `packages/cms/src/index.ts:406` |
| dev-only gate | `packages/cms/src/index.ts:210` |
| editor `injectScript` / CDN bundle | `packages/cms/src/index.ts:319`, `:142` |
| five middlewares | `packages/cms/src/dev-middleware.ts:97,135,166,266,320` |
| HTML rewrite + phase 1/2 | `packages/cms/src/dev-middleware.ts:384,395,400,440,514` |
| `cms-N` id generator | `packages/cms/src/dev-middleware.ts:452` |
| text-search fallback | `packages/cms/src/dev-middleware.ts:635-665`; `packages/cms/src/source-finder/source-lookup.ts:24` |
| reads Astro attrs | `packages/cms/src/html-processor.ts:26,33-49,294-360,808-810` |
| strips Astro attrs | `packages/cms/src/html-processor.ts:883-885,1032-1036` |
| emits `data-cms-id` | `packages/cms/src/html-processor.ts:873` |
| emits `data-cms-component-id` | `packages/cms/src/html-processor.ts:351`, `build-processor.ts:578` |
| prod LCA fallback | `packages/cms/src/build-processor.ts:502,540-595` |
| the write | `packages/cms/src/handlers/source-writer.ts:18,40,58,60,77` |
| lock when unmapped | `packages/cms/src/editor/editor.ts:327-335` |
| `ChangePayload` | `packages/cms/src/editor/editor.ts:833-840` |
| postMessage / POST | `packages/cms/src/editor/api.ts:15-19,22-71,99-118` |
| devToolbar coupling | `packages/nua/src/integration.ts:59-62` |
| canonical payload example | `packages/cms/README.md:84-104` |
| unused `stableId` | `packages/cms/src/utils.ts:90-102` |

**Astro** (`/home/matej21/projects/sandbox/astro`)

| what | where |
|---|---|
| the only `transform()` call + flag | `packages/astro/src/core/compile/compile.ts:44-71` (flag `:55-59`) |
| vite plugin call chain | `packages/astro/src/vite-plugin-astro/index.ts:208,254` |
| the only consumer | `packages/astro/src/runtime/client/dev-toolbar/apps/audit/annotations.ts:11,12,20,26` |
| open-in-editor | `.../audit/ui/audit-ui.ts:75-90` |
| devToolbar defaults | `packages/astro/src/core/config/schemas/base.ts:74-76,293-297`; `src/preferences/defaults.ts:2-5` |
| compiler pin | `packages/astro/package.json:112` (`^2.13.0`) |

**pletivo** (`/home/matej21/projects/oss/pletivo`)

| what | where |
|---|---|
| Bun `.astro` transform | `packages/pletivo/src/astro-plugin.ts:366-371` (plugin reg `:352`) |
| relative filename source | `packages/pletivo/src/astro-css-order.ts:70` |
| Workers `.astro` transform | `packages/workers/src/compile-project.ts:397-402` |
| in-isolate wasm wrapper | `packages/workers/src/astro-compiler.ts:86-92,118` |
| virtual module graph | `packages/workers/src/compile-project.ts:56-97` |
| JSX choke point | `packages/runtime/src/jsx-runtime.ts:92,143,179,181,187,195,198` |
| astro shim render/attrs | `packages/runtime/src/astro-shim.ts:437,532,650,666,796` |
| component boundary | `packages/runtime/src/astro-shim.ts:469-490` (`moduleId` `:475`, `:483`) |
| dev `.tsx` loader hook | `packages/pletivo/src/dev-ts-plugin.ts:33,38,41` |
| MDX `development:false` | `packages/pletivo/src/mdx-plugin.ts:243-246` |
| Workers `production:true` | `packages/workers/src/transpile.ts:83-95` |
| `astro:server:setup` | `packages/pletivo/src/astro-host/runner.ts:355-368` (`injectScript` `:239-242`) |
| connect middleware | `packages/core/src/astro-host/server-shim.ts:45-68`; `packages/pletivo/src/astro-host/connect-bridge.ts:74,103-105` |
| generated worker runtime | `packages/workers/src/generated/runtime-modules.ts`; `packages/workers/scripts/build-runtime.ts` |
| bundle hash | `packages/workers/src/render.ts:1077` |
| dogfood finding | `docs/todos/018-dogfood-ssr-dev-server.md:83-88` |
| frozen-artifact verdict | `docs/todos/020-workers-integration-phase.md` §7 |

## Appendix B — probes run

All in this scratchpad, against `/home/matej21/projects/oss/pletivo/node_modules/@astrojs/compiler`
(3.0.1), read-only, `bun <script>`:

- `probe-annotate.mjs` — `transform()` with and without `annotateSourceFile`; established that the
  attributes are literal text in the `$$render` template, that the value is `filename` (not
  `normalizedFilename`), and that `$$renderComponent` is never annotated.
- `probe-loc.mjs` — loc format and generated-code size delta (1,472→2,028 B small file;
  5,264→28,256 B for 100 elements).
- `probe-loc2.mjs` — the column rule across element-first-child / text-first-child / empty / void /
  self-closing cases.
- `probe-scope.mjs` — established that `TransformResult.scope` is **filename-derived and
  content-stable**, but that the `astro-<hash>` class is only applied when the component has a
  `<style>` block. So the scope hash is *not* a free universal file identifier — worth knowing,
  since it looks like one.
- `probe-size.mjs` — the raw/gzip/brotli table in §6.3, computed on the real built page.

Also verified by grep, not inference: `annotateSourceFile` and `astro-source` have **zero**
occurrences anywhere under `/home/matej21/projects/oss/pletivo/packages/`.
