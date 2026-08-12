---
title: SQLite as a filesystem
date: 2026-02-03
description: There is no disk in an isolate, so the project lives in a table instead.
tags: [storage, durable-objects]
---

A Worker isolate has no filesystem. There is nothing to `readFile` from, no working
directory, and no way to hand the compiler a path. Every source file you edit here
lives in a Durable Object's SQLite database, one row per path.

That turns out to be a better fit than it sounds.

> A filesystem is a key-value store with a tree-shaped key and a lock nobody agrees
> on. Take away the tree and you lose very little.

The store is a map from a project-relative path to its text:

```ts
const files = new Map<string, string>();
files.set("src/pages/index.astro", source);
files.set("src/content/posts/hello.md", markdown);
```

Everything downstream takes that map. Module resolution is a lookup instead of a
`stat` walk. A glob is a scan over keys, sorted so two machines enumerate a
collection in the same order. Tailwind reads its `@import` chain out of the same map.

## What you get for free

Because the project is a row set rather than a directory, a write is a transaction
and a render is a read snapshot. Two people can edit two files at once without either
of them seeing a half-updated project. Point-in-time restore comes from the database,
not from a git history nobody wired up.

What you give up is anything that expects a real path — native tools, watchers, and
any dependency that reaches for `node:fs` at import time.
