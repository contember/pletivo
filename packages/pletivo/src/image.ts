/**
 * Build-time image optimization for pletivo.
 *
 * Provides:
 * - Pure JS image dimension reader (PNG, JPEG, GIF, WebP, SVG)
 * - `getImage()` implementation for Astro's `<Image>` / `<Picture>` components
 * - Transform registry for post-render image processing
 * - Sharp integration (optional) for resize + format conversion
 */

import path from "path";
import fs from "fs/promises";

// ── Types ──────────────────────────────────────────────────────────────

export interface ImageMetadata {
  src: string;
  width: number;
  height: number;
  format: string;
  /** Absolute filesystem path — non-enumerable, for build-time use only. */
  fsPath: string;
}

export interface GetImageResult {
  rawOptions: Record<string, unknown>;
  options: Record<string, unknown>;
  src: string;
  srcSet: { values: SrcSetValue[]; attribute: string };
  attributes: Record<string, unknown>;
}

interface SrcSetValue {
  url: string;
  descriptor: string;
}

export interface ImageTransformEntry {
  sourcePath: string;
  outputPath: string;
  width?: number;
  height?: number;
  format: string;
  quality?: number | string;
}

// ── Runtime state ──────────────────────────────────────────────────────

let imageMode: "dev" | "build" = "dev";
let basePath = "/";

export function setImageMode(mode: "dev" | "build", base: string): void {
  imageMode = mode;
  basePath = base.replace(/\/$/, "");
  probeCache.clear();
  probeInflight.clear();
}

/**
 * Build the URL for an image given its on-disk path and the hashed
 * output path under `_astro/`. In dev mode we point at the dev server's
 * `/@image/` route (which serves the original file); in build we use
 * the hashed dist URL that `processImages()` writes.
 */
export function imageUrlFor(fsPath: string, outputPath: string): string {
  return imageMode === "build"
    ? `${basePath}/${outputPath}`
    : `/@image/${path.basename(fsPath)}?f=${fsPath}`;
}

// ── Transform registry ─────────────────────────────────────────────────

const transforms = new Map<string, ImageTransformEntry>();

/**
 * Images that were ESM-imported but may not go through `getImage()`.
 * For example, `<img src={photo.src}>` uses the metadata directly.
 * These need to be copied to `dist/` as-is (no resize/format change).
 */
const importedImages = new Map<
  string,
  { sourcePath: string; outputPath: string }
>();

export function registerImportedImage(
  sourcePath: string,
  outputPath: string,
): void {
  importedImages.set(outputPath, { sourcePath, outputPath });
}

function registerTransform(entry: ImageTransformEntry): void {
  transforms.set(entry.outputPath, entry);
}

export function getTransforms(): Map<string, ImageTransformEntry> {
  return transforms;
}

export function getImportedImages(): Map<
  string,
  { sourcePath: string; outputPath: string }
> {
  return importedImages;
}

export function clearTransforms(): void {
  transforms.clear();
  importedImages.clear();
}

// ── Image config ───────────────────────────────────────────────────────

export const imageConfig: Record<string, unknown> = {
  experimentalLayout: undefined,
  experimentalResponsiveImages: false,
  service: { entrypoint: "" },
  domains: [],
  remotePatterns: [],
};

// ── Pure JS image dimension reader ─────────────────────────────────────

interface ImageDimensions {
  width: number;
  height: number;
  format: string;
}

export async function readImageDimensions(
  filePath: string,
): Promise<ImageDimensions> {
  const buffer = await Bun.file(filePath).arrayBuffer();
  return readImageDimensionsFromBuffer(buffer, filePath);
}

function readImageDimensionsFromBuffer(
  buffer: ArrayBuffer,
  filePath: string,
): ImageDimensions {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  // PNG: 8-byte signature, IHDR width at 16, height at 20 (BE uint32)
  if (
    bytes.length > 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return {
      width: view.getUint32(16),
      height: view.getUint32(20),
      format: "png",
    };
  }

  // GIF: "GIF87a" or "GIF89a", width at 6 (LE uint16), height at 8
  if (
    bytes.length > 10 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46
  ) {
    return {
      width: view.getUint16(6, true),
      height: view.getUint16(8, true),
      format: "gif",
    };
  }

  // JPEG: scan markers for SOF0 (0xC0) or SOF2 (0xC2)
  if (bytes.length > 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset < bytes.length - 9) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1];
      // SOF0 or SOF2 — frame header with dimensions
      if (marker === 0xc0 || marker === 0xc2) {
        return {
          height: view.getUint16(offset + 5),
          width: view.getUint16(offset + 7),
          format: "jpeg",
        };
      }
      // Skip segment
      if (marker === 0xd9) break; // EOI
      if (marker === 0xda) break; // SOS — no more metadata
      const segLen = view.getUint16(offset + 2);
      offset += 2 + segLen;
    }
    // Fallback: JPEG without findable SOF
    return { width: 0, height: 0, format: "jpeg" };
  }

  // WebP: "RIFF" + "WEBP" container
  if (
    bytes.length > 30 &&
    view.getUint32(0) === 0x52494646 && // RIFF
    view.getUint32(8) === 0x57454250 // WEBP
  ) {
    const chunkFourCC = String.fromCharCode(
      bytes[12],
      bytes[13],
      bytes[14],
      bytes[15],
    );
    if (chunkFourCC === "VP8 " && bytes.length > 29) {
      return {
        width: view.getUint16(26, true) & 0x3fff,
        height: view.getUint16(28, true) & 0x3fff,
        format: "webp",
      };
    }
    if (chunkFourCC === "VP8L" && bytes.length > 24) {
      const bits = view.getUint32(21, true);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
        format: "webp",
      };
    }
    if (chunkFourCC === "VP8X" && bytes.length > 29) {
      return {
        width:
          (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)) + 1,
        height:
          (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) + 1,
        format: "webp",
      };
    }
    return { width: 0, height: 0, format: "webp" };
  }

  // SVG: no intrinsic pixel dimensions from headers
  const head = new TextDecoder().decode(
    bytes.slice(0, Math.min(256, bytes.length)),
  );
  if (head.includes("<svg") || head.trimStart().startsWith("<?xml")) {
    // Try to extract width/height from the <svg> tag
    const wMatch = head.match(/\bwidth="(\d+)/);
    const hMatch = head.match(/\bheight="(\d+)/);
    return {
      width: wMatch ? parseInt(wMatch[1], 10) : 0,
      height: hMatch ? parseInt(hMatch[1], 10) : 0,
      format: "svg",
    };
  }

  throw new Error(`Unsupported image format: ${filePath}`);
}

// ── Image probing + registration ───────────────────────────────────────

/** Build an ImageMetadata with `fsPath` non-enumerable so it doesn't leak through JSON.stringify. */
export function makeImageMetadata(parts: {
  src: string;
  width: number;
  height: number;
  format: string;
  fsPath: string;
}): ImageMetadata {
  const { fsPath, ...visible } = parts;
  const meta = { ...visible } as ImageMetadata;
  Object.defineProperty(meta, "fsPath", { value: fsPath, enumerable: false });
  return meta;
}

interface ProbeResult {
  width: number;
  height: number;
  format: string;
  contentHash: string;
  outputPath: string;
}

/**
 * Per-process cache of dimensions + content hash, keyed by absolute path.
 * Multiple call sites hashing the same image (a logo on every entry, an
 * ESM-imported asset rendered in many pages) probe it once. Cleared on
 * `setImageMode()` so each dev/build run starts fresh.
 *
 * `probeInflight` deduplicates concurrent calls for the same path — under
 * `Promise.all` page rendering (build.ts), two pages racing on the same
 * image both see an empty cache, so without the in-flight map both would
 * read+hash the file in parallel.
 */
const probeCache = new Map<string, ProbeResult>();
const probeInflight = new Map<string, Promise<ProbeResult>>();

export async function probeAndRegisterImage(fsPath: string): Promise<ProbeResult> {
  const cached = probeCache.get(fsPath);
  if (cached) return cached;
  const inflight = probeInflight.get(fsPath);
  if (inflight) return inflight;

  const promise = (async () => {
    const buffer = await Bun.file(fsPath).arrayBuffer();
    const dims = readImageDimensionsFromBuffer(buffer, fsPath);

    const hasher = new Bun.CryptoHasher("md5");
    hasher.update(buffer);
    const contentHash = hasher.digest("hex").slice(0, 8);

    const ext = path.extname(fsPath);
    const base = path.basename(fsPath, ext);
    const outputPath = `_astro/${base}.${contentHash}${ext}`;

    registerImportedImage(fsPath, outputPath);

    const result: ProbeResult = { ...dims, contentHash, outputPath };
    probeCache.set(fsPath, result);
    return result;
  })();

  probeInflight.set(fsPath, promise);
  try {
    return await promise;
  } finally {
    probeInflight.delete(fsPath);
  }
}

// ── getImage() ─────────────────────────────────────────────────────────

function computeHash(...parts: (string | number | undefined)[]): string {
  const hasher = new Bun.CryptoHasher("md5");
  hasher.update(parts.map(String).join("|"));
  return hasher.digest("hex").slice(0, 8);
}

function isImageMetadata(src: unknown): src is ImageMetadata {
  return (
    typeof src === "object" &&
    src !== null &&
    "src" in src &&
    "width" in src &&
    "height" in src &&
    "format" in src
  );
}

export async function getImage(
  options: Record<string, unknown>,
): Promise<GetImageResult> {
  // Resolve src — may be a dynamic import Promise
  let src = options.src as unknown;
  if (src && typeof src === "object" && "then" in src) {
    const resolved = await (src as Promise<{ default?: unknown }>);
    src = resolved.default ?? resolved;
  }

  const metadata = isImageMetadata(src) ? (src as ImageMetadata) : null;
  const srcPath = metadata ? metadata.src : String(src ?? "");
  const fsPath =
    metadata?.fsPath ??
    (metadata as Record<string, unknown> | null)?.["fsPath"];

  // Compute dimensions
  const origW = metadata?.width;
  const origH = metadata?.height;
  let width = options.width as number | undefined;
  let height = options.height as number | undefined;

  if (typeof width === "string") width = parseInt(width, 10);
  if (typeof height === "string") height = parseInt(height, 10);

  if (origW && origH) {
    const ratio = origW / origH;
    if (width && !height) height = Math.round(width / ratio);
    else if (height && !width) width = Math.round(height * ratio);
    else if (!width && !height) {
      width = origW;
      height = origH;
    }
  }

  // Output format — SVG stays SVG, otherwise default to webp
  const sourceFormat = metadata?.format ?? "png";
  const format =
    (options.format as string) ??
    (sourceFormat === "svg" ? "svg" : "webp");
  const quality = options.quality as number | string | undefined;

  // Compute deterministic output path
  const hash = computeHash(srcPath, width, height, format, quality);
  const baseName = path.basename(srcPath, path.extname(srcPath));
  const outputFile = `_astro/${baseName}.${hash}.${format}`;

  let finalSrc: string;

  if (imageMode === "build") {
    // Register for post-render processing
    registerTransform({
      sourcePath: (fsPath as string) ?? srcPath,
      outputPath: outputFile,
      width,
      height,
      format,
      quality,
    });
    finalSrc = `${basePath}/${outputFile}`;
  } else {
    // Dev mode — serve original file
    if (fsPath) {
      finalSrc = `/@image/${path.basename(fsPath as string)}?f=${fsPath}`;
    } else {
      finalSrc = srcPath;
    }
  }

  // Build HTML attributes — only include image-relevant ones
  const attributes: Record<string, unknown> = {};
  if (width) attributes.width = width;
  if (height) attributes.height = height;
  attributes.loading = options.loading ?? "lazy";
  attributes.decoding = options.decoding ?? "async";
  if (options.alt !== undefined) attributes.alt = options.alt;

  // Pass through data-* and common HTML attributes
  for (const [k, v] of Object.entries(options)) {
    if (
      k.startsWith("data-") ||
      k === "class" ||
      k === "style" ||
      k === "id" ||
      k === "role" ||
      k === "fetchpriority"
    ) {
      attributes[k] = v;
    }
  }

  return {
    rawOptions: { ...options, src },
    options: { ...options, src, width, height, format },
    src: finalSrc,
    srcSet: { values: [], attribute: "" },
    attributes,
  };
}

// ── Post-render image processing ───────────────────────────────────────

export async function processImages(
  registered: Map<string, ImageTransformEntry>,
  distDir: string,
): Promise<number> {
  // Also copy imported images that weren't processed by getImage()
  const imported = getImportedImages();
  for (const [outputPath, entry] of imported) {
    if (!registered.has(outputPath)) {
      registered.set(outputPath, {
        sourcePath: entry.sourcePath,
        outputPath: entry.outputPath,
        format: path.extname(entry.sourcePath).slice(1),
      });
    }
  }

  if (registered.size === 0) return 0;

  let sharp: ((input: string) => SharpPipeline) | null = null;
  try {
    sharp = require("sharp");
  } catch {
    console.warn(
      "  sharp not installed — images will be copied without optimization.",
    );
    console.warn('  Install sharp for resize + format conversion: bun add sharp');
  }

  let count = 0;
  for (const [, entry] of registered) {
    const outFile = path.join(distDir, entry.outputPath);
    await fs.mkdir(path.dirname(outFile), { recursive: true });

    if (sharp && entry.format !== "svg") {
      try {
        let pipeline = sharp(entry.sourcePath);

        // Auto-rotate based on EXIF orientation
        pipeline = pipeline.rotate();

        // Resize if dimensions specified and different from original
        if (entry.width || entry.height) {
          pipeline = pipeline.resize(entry.width, entry.height, {
            fit: "cover" as const,
            withoutEnlargement: true,
          });
        }

        // Convert format
        const fmt = entry.format === "jpg" ? "jpeg" : entry.format;
        const qualityMap: Record<string, number> = {
          low: 25,
          mid: 50,
          high: 80,
          max: 100,
        };
        const q =
          typeof entry.quality === "string"
            ? (qualityMap[entry.quality] ?? 80)
            : (entry.quality ?? 80);

        pipeline = pipeline.toFormat(fmt as keyof SharpFormatMap, {
          quality: q,
        });

        const { data } = await pipeline.toBuffer({ resolveWithObject: true });
        await fs.writeFile(outFile, data);
      } catch (e) {
        console.warn(
          `  Warning: sharp failed for ${entry.sourcePath}: ${e instanceof Error ? e.message : e}`,
        );
        await fs.copyFile(entry.sourcePath, outFile);
      }
    } else {
      // No sharp or SVG — copy as-is
      await fs.copyFile(entry.sourcePath, outFile);
    }
    count++;
  }

  return count;
}

// Sharp types (minimal, to avoid importing @types/sharp)
interface SharpPipeline {
  rotate(): SharpPipeline;
  resize(
    w?: number,
    h?: number,
    opts?: { fit?: string; withoutEnlargement?: boolean },
  ): SharpPipeline;
  toFormat(fmt: string, opts?: { quality?: number }): SharpPipeline;
  toBuffer(opts?: {
    resolveWithObject: true;
  }): Promise<{ data: Buffer; info: unknown }>;
}
type SharpFormatMap = Record<string, unknown>;
