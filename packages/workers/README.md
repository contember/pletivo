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
      compatibilityDate: "2026-01-01",
      compatibilityFlags: ["nodejs_compat"],
      outbound: { kind: "blocked" },
    });
    const page = await host.render(new URL(request.url).pathname);
    return new Response(page.html, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
};
```

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

## Hosting a live workspace

`createProjectHost(...).fetch` answers, first match wins:

1. a generated `?url` asset (`/_astro/…`): the in-memory cache, then `generatedAssetStore`;
2. a processed `<script>` (`/_pletivo/script/…`) or a module it imports
   (`/_pletivo/module/…`), served unbundled with bare imports rewritten to the artifact's
   browser graph;
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
- `host.features()` — the files that use MDX, `client:*` islands, endpoints or
  `prerender = false`, none of which this host renders.

## Versioning

The modules are the API, and they are pre-1.0: a minor release can change them. Pin the
version and upgrade `@pletivo/workers`, `@pletivo/core` and `@pletivo/runtime` together.
