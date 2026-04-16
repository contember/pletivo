# Image Optimization

**Priority:** A-tier
**Status:** Done (basic), sharp optional for full optimization

## What was implemented

1. **`astro:assets` virtual module** — exports `getImage()`, `imageConfig`, `Image`, `Picture`. Makes Astro's built-in `<Image>` and `<Picture>` components work when Astro is installed.

2. **ESM image import handler** — Bun plugin intercepts `.png`, `.jpg`, `.jpeg`, `.webp`, `.avif`, `.gif`, `.tiff`, `.svg` imports. Returns `ImageMetadata` with `{ src, width, height, format }` and non-enumerable `fsPath`. Pure JS dimension reader (no native deps) handles PNG, JPEG, GIF, WebP, SVG headers.

3. **`getImage()` implementation** — resolves async src, computes dimensions from metadata + aspect ratio, determines output format (default: webp, SVG stays SVG), generates deterministic hashed output path, registers transforms for build-time processing. Returns `{ src, srcSet, attributes }`.

4. **Build-time processing** — post-render phase processes all registered transforms. With sharp: resize + format conversion + quality control. Without sharp: copies as-is with a warning.

5. **Passthrough for raw imports** — `<img src={photo.src}>` works: imported images are automatically copied to `dist/_astro/` even without `getImage()`.

6. **`mrmime` shim** — virtual module so `Picture.astro` can resolve its MIME lookup dependency without adding an npm package.

7. **Dev mode** — `/@image/` route serves original files from filesystem. No optimization in dev.

## Limitations

- **Requires Astro as a project dependency** for `<Image>` / `<Picture>` components (they're .astro files from the astro package). Works in astro-host mode. Standalone pletivo mode needs a native `<Image>` component (future work).
- **No responsive images / srcset / densities** yet — `srcSet` always returns empty.
- **sharp is optional** — without it, images are copied unoptimized.
- **Remote images not supported** — only local ESM imports.

## Files

- `packages/pletivo/src/image.ts` — core: types, dimension reader, getImage, registry, processImages
- `packages/pletivo/src/astro-plugin.ts` — astro:assets module, mrmime shim, image onLoad handler
- `packages/pletivo/src/build.ts` — image processing integration
- `packages/pletivo/src/dev.ts` — dev server image route
- `tests/integration/image.test.ts` — 9 tests
- `tests/fixture-image/` — test fixture with PNG image
