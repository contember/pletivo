---
title: Typed content collections
date: 2026-03-10
description: A Zod schema turns loose frontmatter into data a page can rely on.
tags: [content, zod]
draft: true
---

This post is a draft. It is loaded, validated and then filtered out — it does not
appear on the index and it has no URL of its own. Flip `draft: false` in its
frontmatter and it shows up.

## Why a schema

Frontmatter is YAML, and YAML will happily give you a string where you wanted a date,
or nothing at all where you wanted a list. The schema in `src/content.config.ts` runs
before any page sees an entry:

- `z.coerce.date()` turns `2026-03-10` into a real `Date`, so sorting is a subtraction.
- `.default([])` means a post without tags still renders the tag list.
- A missing `description` is an error at render time, naming the file — not a blank
  space someone notices in production.

## Where it runs

Validation happens where the page runs, which here is inside the Worker. There is no
prior step that wrote a manifest, so a broken post fails the request that asked for
it and nothing else. The rest of the site keeps rendering.

That is the whole content layer: a loader that scans a directory, a schema that
parses each file, and a `getCollection` call that hands you the results in a stable
order.
