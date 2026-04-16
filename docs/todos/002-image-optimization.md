# Image Optimization

**Priority:** A-tier
**Status:** Stubbed (no-op)
**Area:** Assets / Built-in Components

## Problem

`<Image>` and `<Picture>` components from `astro:components` compile and render, but all image services (`sharpImageService`, `squooshImageService`, `passthroughImageService`) return empty objects. No build-time image optimization happens.

## Current State

- `astro-plugin.ts`: image service exports return `{}`
- Components render but output unoptimized `<img>` tags
- No width/height inference, no format conversion, no responsive srcset generation

## Expected Behavior

At minimum, build-time image optimization via `sharp`:
- Format conversion (e.g. `.png` -> `.webp`/`.avif`)
- Resize to specified dimensions
- Output hashed filenames to `_astro/` assets dir
- `<Image>`: renders `<img>` with correct `width`/`height`/`src`
- `<Picture>`: renders `<picture>` with `<source>` elements for multiple formats
- `getImage()` function for programmatic use

## Notes

This is the single biggest gap for real-world adoption. Many Astro projects rely heavily on built-in image optimization.

## Files

- `packages/pletivo/src/astro-plugin.ts` — image service stubs (lines ~246-249)
