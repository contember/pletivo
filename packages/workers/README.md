# @pletivo/workers

The Cloudflare Worker host for [Pletivo](https://github.com/contember/pletivo). A host
Worker hands it a project's source files; it compiles them (`.astro`, TSX, Markdown, CSS,
Tailwind v4) into a module graph and renders pages in a dynamic isolate created through a
[Worker Loader](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/)
binding. No build step and no file system: the project can live in a Durable Object and
change between requests.

```bash
npm install @pletivo/workers
```

It depends on `@pletivo/core` and `@pletivo/runtime`, which are released in lockstep with
it under the same version.

## Consuming it

The package ships TypeScript source, not a build. `exports` maps every module under
`src/` (`@pletivo/workers/project-host`, `@pletivo/workers/render`, …) to its `.ts` file,
and **your Worker's bundler compiles it** together with your own code. That is deliberate:
only the host Worker's bundler can embed `@astrojs/compiler`'s `astro.wasm` and
Tailwind's stylesheets.

Your `wrangler.jsonc` needs:

```jsonc
{
  // The render isolate's Astro shim imports `node:async_hooks`.
  "compatibility_flags": ["nodejs_compat"],
  // The binding that creates the render isolates.
  "worker_loaders": [{ "binding": "LOADER" }],
  "rules": [
    // `@astrojs/compiler/astro.wasm` must arrive as a WebAssembly.Module:
    // workerd forbids `WebAssembly.compile()` at run time.
    { "type": "CompiledWasm", "globs": ["**/*.wasm"], "fallthrough": true },
    // Only when projects use Tailwind: its stylesheets, embedded as text.
    { "type": "Text", "globs": ["**/*.css"], "fallthrough": true }
  ]
}
```

`tailwindcss` is a peer dependency. The host imports it, so your bundler needs it
installed even when no project uses Tailwind. Pass its four stylesheets as `tailwind` to
`createProjectHost` only if your projects use Tailwind; without them, a project that
imports Tailwind fails with `TailwindNotConfiguredError`.

The smallest host:

```ts
import { bundledAstroCompiler } from "@pletivo/workers/bundled-astro-compiler";
import { createProjectHost } from "@pletivo/workers/project-host";
import { createMapProjectStore } from "@pletivo/workers/project-store";
import type { WorkerLoaderBinding } from "@pletivo/workers/render";

interface Env {
  LOADER: WorkerLoaderBinding;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const host = createProjectHost({
      store: createMapProjectStore(new Map([["src/pages/index.astro", "<h1>Hello</h1>"]])),
      loader: env.LOADER,
      compiler: bundledAstroCompiler(),
      compatibilityDate: "2026-01-01",
      compatibilityFlags: ["nodejs_compat"],
      outbound: { kind: "blocked" },
    });
    const page = await host.render(new URL(request.url).pathname);
    return new Response(page.html, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
};
```

### Where the Astro compiler runs

Every host passes a `compiler`. `bundledAstroCompiler()` runs `@astrojs/compiler` in the
host's own isolate, and importing `@pletivo/workers/bundled-astro-compiler` is what puts
`astro.wasm` in your bundle. The Go program's memory grows to what the largest source
needed and is never returned, so a host whose isolate is short of memory, such as a Durable
Object that also holds a workspace, can compile in a Worker Loader isolate of its own:

```ts
import astroWasm from "@astrojs/compiler/astro.wasm"; // as bytes: a `Data` rule for this file
import { createIsolateAstroCompiler } from "@pletivo/workers/compiler-isolate";

const compiler = createIsolateAstroCompiler({
  loader: env.LOADER,
  namespace: { tenant: projectId, capabilityGeneration: "v1" },
  compatibilityDate: "2026-01-01",
  compatibilityFlags: ["nodejs_compat"],
  wasm: () => astroWasm,
});
```

Each call is one `fetch` to that isolate, about a millisecond when it is warm; Pletivo
compiles a file once per source and caches it.

Your TypeScript program checks this source as part of your own code. It needs
`@cloudflare/workers-types` and `@types/node` in `types`, `"moduleResolution": "bundler"`,
and `"allowImportingTsExtensions": true` (with `noEmit`), because the modules import each
other with `.ts` extensions.

Two complete hosts live in the repository:

- [`example/`](https://github.com/contember/pletivo/tree/main/packages/workers/example) — a
  stateless preview that renders a project posted as JSON.
- [`example-playground/`](https://github.com/contember/pletivo/tree/main/packages/workers/example-playground)
  — a live workspace in a Durable Object, with content collections and an editor. This is
  the reference for a production binding topology.

## Prepared projects

A project with npm dependencies or Astro integrations is rendered with the artifact
`pletivo prepare` writes: `.pletivo/pletivo-artifact.json` (pass it as `artifact`, or name
it with `artifactPath`), and the same value as a TypeScript module.

### Portable Markdown plugins

A remark or rehype plugin is a live function, and an artifact is data. A plugin can say
where the render isolate imports the same function from:

```js
// in the package that ships the plugin
export function remarkExample(options) { /* ... */ }
remarkExample[Symbol.for("pletivo.portableModule")] = {
  module: "example-package/remark", // a bare specifier the project can import
  export: "remarkExample",          // the named export of that same function
};
```

`pletivo prepare` records `{ module, export, options }` for a tagged plugin and vendors
`module`. Options (the second element of `[plugin, options]`) must be JSON data. The
isolate imports the plugins and installs them in config order, for collection entries and
`.md` pages alike. An untagged plugin still fails `prepare` with a diagnostic naming it.

### Tailwind plugins and configs

A stylesheet's `@plugin "x"` and `@config "x"` load a JavaScript module that Tailwind calls
while it compiles, and the host worker cannot evaluate one. `pletivo prepare` resolves each
target as Tailwind's Node loader would and bundles it, CommonJS dependencies included, into
one ES module in the artifact, and adds Tailwind itself as one more. When a page's
stylesheet closure has such a rule, its Tailwind compiles in a separate Loader isolate that
holds the artifact's Tailwind and those modules, with no network access; pages with the
same modules share that isolate. Without such a rule, Tailwind compiles in the host as
before.

The target must be an installed package; a project-local plugin or config file (the usual
`@config "./tailwind.config.js"` included), a workspace package linked into `node_modules`,
a plugin that needs a Node built-in or reads CommonJS `module.id`, and one that fails to
bundle fail `prepare` naming the stylesheet and the rule. A rule the artifact does not
answer fails the render with `UnresolvedImportError` whose specifier is the rule's
resolution key, `@plugin x`: kind `missing` (a stylesheet added since `prepare`), or
`tailwind-module-not-a-package` for a project stylesheet's path outside any `node_modules`
(see `UnresolvedImportError.kind` below). A rule in a stylesheet a page reaches only
through `@reference` is not supported and fails the render naming that.

The host bundle carries no second copy of Tailwind for the isolate. `pletivo prepare`
writes it into the artifact, as module `tailwind-runtime:v1` (about 300 KB), only when a
stylesheet has a `@plugin` or `@config` rule. It is pletivo's own `tailwindcss`, not the
project's, and the isolate compiles with it against the four stylesheets passed as
`tailwind`. A rule in an artifact without any such module, one prepared by a pletivo that
did not write it, fails the render with `UnresolvedImportError` of kind `missing`:
preparing again answers it. An artifact whose module was made for another contract (a
`tailwind-runtime:` id other than this host's, from a pletivo of another release) fails
with kind `tailwind-runtime-unsupported` instead, naming both ids: preparing again with the
same pletivo writes the same module, so only a pletivo released with this host fixes it.

## Hosting a live workspace

`createProjectHost(...).fetch` answers, first match wins:

1. a generated `?url` asset (`/_astro/…`): the in-memory cache, then `generatedAssetStore`;
2. a processed `<script>` (`/_pletivo/script/…`) or a module it imports
   (`/_pletivo/module/…`), served unbundled with bare imports rewritten to the artifact's
   browser graph. A package module is imported at `?v=<artifactBrowserVersion>` and
   cached `immutable` there; project files and scripts are `no-cache`;
3. a file in `public/`, with its exact bytes;
4. an image output (`/_astro/<name>.<hash>.<ext>`);
5. a redirect from `trailingSlash`, config `redirects` or i18n routing;
6. a rendered page.

Options a multi-session host needs:

- `generatedAssetStore` — durable storage for `?url` assets (`MemoryGeneratedAssetStore`
  implements the port for tests).
- `content: { binding, store, owner }` with an entrypoint that answers through
  `store.forOwner(owner)`, so one session's render cannot read another's content.
- `createWorkspaceProjectStore(fs, { root, revision: (root) => … })` — pass a revision
  scoped to `root` so writes elsewhere keep the snapshot.
- `annotateSourceFile` — `data-astro-source-file`/`-loc` on every element, for a visual
  editor.
- `onRender` — each page render's bounded console output (`RenderedPage.logs`).
- `onBrowserModuleError` — each failed `/_pletivo/script/…` or `/_pletivo/module/…`
  request, with its `BrowserModuleError`. An `UnresolvedBrowserImportError` names the
  `importer` and the `specifier` the artifact's browser graph does not carry, so a
  host that prepares artifacts on demand can tell that `pletivo prepare` must run again.
  On the server side, an import nothing answers is an `UnresolvedImportError` (an
  `UnsupportedFileError`, exported from `compile-project.ts`) with the same fields and a
  `reason`.
- `UnresolvedImportError.kind` — an `UnresolvedImportKind`. Only `missing` means the
  artifact carries no resolution for the importer and specifier, so only that kind is
  worth preparing again; the others, such as `unsupported-package-root`, fail against any
  artifact. For a Tailwind `@plugin` or `@config` rule the specifier is the rule's
  resolution key, `@plugin x`; the rule is `missing` too when the artifact answers it but
  carries no Tailwind for the isolate, and `tailwind-runtime-unsupported` when its Tailwind
  was made for another contract than this host's, which only a `prepare` by a pletivo
  released with this host fixes. A project stylesheet's rule the artifact does not
  answer and whose path names a file outside any `node_modules` is `tailwind-module-not-a-package`:
  `pletivo prepare` bundles only installed packages, so no artifact will answer it. A
  path into a `node_modules` (a monorepo's hoisted one above the project included), or one
  in a package's own stylesheet, is `missing`.
- `host.features()` — the files that use MDX, `client:*` islands, endpoints or
  `prerender = false`, none of which this host renders.
- `modulePreload` (default `true`) — a rendered page gets a `<link rel="modulepreload">`
  for every `/_pletivo/…` module its scripts reach through static imports, dependencies
  first, so the browser fetches the graph in parallel instead of one import level per
  round trip. Modules reached only through `import()` get none. What each module imports
  is kept per snapshot revision, so a render of an unchanged page reads no module again.
  `false` turns it off.
- `host.warmUp({ pathname })` — the cold half of a render ahead of the first request:
  load the artifact, compile the page's module graph, create its render isolate and
  import the page there, rendering nothing; with `modulePreload` it also walks the
  preload graph. `pathname` defaults to `/`. A warm-up of the same pathname in flight is
  shared. A render of that pathname arriving meanwhile waits for it, at most
  `warmUpWaitMs` (default 5000), and reuses its work; every other request goes ahead. It
  rejects with what `render()` would throw, so catch it, e.g.
  `ctx.waitUntil(host.warmUp().catch(() => {}))` in a Durable Object constructor.

## Versioning

The modules are the API, and they are pre-1.0: a minor release can change them. Pin the
version and upgrade `@pletivo/workers`, `@pletivo/core` and `@pletivo/runtime` together.
