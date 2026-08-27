# 015 — `routeToOutputPath` accepts a param it cannot use

**Priority:** C-tier
**Status:** Open
**Area:** Routing

## Problem

`packages/core/src/router.ts`, `routeToOutputPath()`:

```ts
} else if (seg.type === "param") {
  parts.push(params[seg.value]);
```

`RouteParams` is `{ [key: string]: string | undefined }`, so this pushes
`string | undefined` into a `string[]`. The `rest` branch right below it handles
the `undefined` case deliberately (a catch-all that matched nothing); the
`param` branch does not.

## What actually happens

Measured, not assumed — a `getStaticPaths()` entry that omits a param throws:

```
TypeError: The "paths[1]" property must be of type string, got undefined
```

So this is **not** silent corruption: no route is emitted with the literal
string `undefined` in its path. It fails loudly.

The problem is the message. It names `paths[1]` — an argument index inside
`path.join` — and says nothing about which route, which param, or which
`getStaticPaths()` entry produced it. For a site with a few hundred generated
routes that is a long hunt for a one-line typo in a params object.

## Why it is worth fixing anyway

The repo has no `tsc` gate today, so the type hole is invisible. It stops being
invisible the moment `@pletivo/core` is type-checked on its own, which the
Workers host needs. Fixing it then under time pressure is worse than fixing it
now.

## Fix direction

Throw from `routeToOutputPath` with the route file, the param name, and the
params object it was given. That satisfies the type checker and replaces the
`path.join` TypeError with a message that points at the actual mistake.

Found while moving the router into `@pletivo/core`; pre-existing, unchanged by
the move.

## Files

- `packages/core/src/router.ts` — `routeToOutputPath()`
