# Content Layer — Custom Loaders

**Priority:** B-tier
**Status:** Only glob() implemented
**Area:** Content Collections

## Problem

Astro's Content Layer API allows custom loaders beyond `glob()`. CMS integrations (Contentful, Sanity, Storyblok, Notion) ship their own loaders that fetch content at build time. Currently Pletivo only supports `glob()`.

## Current State

- `collection.ts`: only `glob()` loader is implemented
- No loader protocol/interface for third-party loaders

## Expected Behavior

A loader is an object (or function returning an object) with:
```ts
interface Loader {
  name: string;
  load(context: LoaderContext): Promise<void>;
  schema?: ZodSchema;
}
```

Where `LoaderContext` provides:
- `store` — key-value store to `set(id, entry)` collection entries
- `meta` — persistent metadata (e.g. last sync cursor)
- `logger` — integration logger
- `config` — Astro config
- `parseData({ id, data })` — validate entry against collection schema

## Notes

This unlocks the entire CMS integration ecosystem. Without it, non-file-based content requires workarounds (pre-build scripts that write JSON/MD files).

## Files

- `packages/pletivo/src/content/collection.ts` — collection and loader implementation
