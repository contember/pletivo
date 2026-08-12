# pletivo playground

An Astro blog that lives in a Durable Object, an editor in the browser, and nothing in
between. Change a component, hit save, watch the page come back rendered — no build, no
deploy, no file system.

```bash
bunx wrangler@4 dev --config packages/workers/example-playground/wrangler.jsonc
open http://localhost:8787/__playground
```

## What it is made of

```
SQLiteWorkspaceProvider  ->  createWorkspaceProjectStore  ->  createProjectHost
      (the sources)              (the project, now)            (route, render, serve)
```

`ProjectDO` holds the two things only a Durable Object can have — its storage and its
bindings — and forwards everything else to those factories. The render itself happens in
a **dynamic Worker**: `env.LOADER` creates an isolate out of modules this worker compiled
a moment ago, with `globalOutbound: null`, so a page being rendered can reach nothing.

`docs/todos/023` is the design; `packages/workers/example-workspace/` is the same thing
with `curl` instead of a UI.

## Routes

| | |
|---|---|
| `GET /__playground` | the editor |
| `GET /__paths` | every page the project can enumerate, dynamic routes expanded |
| `GET /__files` | the paths in the workspace, and its revision |
| `GET/PUT/DELETE /__files/<path>` | one source |
| `POST /__reset` | throw the edits away, re-seed |
| `GET /<anything>` | that page, rendered out of the workspace |

The site is at `/`, not under a prefix, so the links a page writes are the links that
work. The editor lives at `/__playground` for the same reason.

## The seed project

`project/` is a small technical blog — four posts in a content collection, a layout, two
components, Tailwind v4 through `@import "tailwindcss"`. They are real files: wrangler's
`Text` rules turn each one into a string at bundle time, `seed.ts` maps them to their
project paths, and `ProjectDO` writes them into SQLite the first time it is asked for a
page. After that the workspace is the source of truth and `project/` is only the thing
`POST /__reset` goes back to.

Two details worth knowing before editing it:

- The config is `content.config.mjs`, not `.ts`. A `.ts` file resolves as TypeScript, so
  it cannot also be a text module. Astro accepts either name.
- Tailwind utilities are generated from the **rendered HTML**, so a class assembled at
  run time (`` `text-${color}-500` ``) produces nothing. Write the class out in full.

## Deploying

`wrangler deploy --config packages/workers/example-playground/wrangler.jsonc`

Needs an account with the Worker Loader beta enabled — that binding is what runs code
produced at run time, and there is no substitute for it. SQLite-backed Durable Objects
and `nodejs_compat` are ordinary.

One object serves one project, so one project renders one page at a time. That ceiling is
fine for a playground and is the open question in `docs/todos/023 §8` for anything larger.
