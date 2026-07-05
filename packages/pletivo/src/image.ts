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
import { createRequire } from "module";
import { withBase } from "./base";
import { recordRuntimeDep } from "./incremental/dep-tracker";

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

export function setImageMode(mode: "dev" | "build"): void {
  imageMode = mode;
  probeCache.clear();
  probeInflight.clear();
}

/**
 * Build the URL for an image given its on-disk path and the hashed
 * output path under `_astro/`. In dev mode we point at the dev server's
 * `/@image/` route (which serves the original file); in build we use
 * the hashed dist URL that `processImages()` writes. Both forms are
 * prefixed with the configured base path.
 */
export function imageUrlFor(fsPath: string, outputPath: string): string {
  return imageMode === "build"
    ? withBase(`/${outputPath}`)
    : withBase(`/@image/${path.basename(fsPath)}?f=${fsPath}`);
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
    recordRuntimeDep(fsPath);
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
    if (fsPath) {
      // On-disk source (ESM-imported or probed asset): optimize/copy it
      // into _astro/ during post-render processing.
      registerTransform({
        sourcePath: fsPath as string,
        outputPath: outputFile,
        width,
        height,
        format,
        quality,
      });
      finalSrc = withBase(`/${outputFile}`);
    } else {
      // Bare string src with no on-disk source: a public-root path
      // (e.g. "/uploads/foo.jpg") or a remote URL. Astro does not run
      // these through the asset pipeline, so pass the reference through
      // unchanged. Public files are emitted and hashed separately — the
      // rendered HTML is rewritten against the public manifest — and
      // remote URLs are fetched by the browser.
      finalSrc = srcPath;
    }
  } else {
    // Dev mode — serve original file
    if (fsPath) {
      finalSrc = withBase(`/@image/${path.basename(fsPath as string)}?f=${fsPath}`);
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

// ── Cloudflare-style image resizing (dev only) ──────────────────────────
//
// Cloudflare serves on-the-fly image transforms from URLs shaped like
//   /cdn-cgi/image/<options>/<source>
// where <source> is a same-zone path (served from public/ in dev) or an
// absolute URL, and <options> is a comma-separated list of key=value
// pairs (width, height, quality, format, fit, …). In production these are
// handled by Cloudflare's edge; the dev server reimplements the common
// subset with sharp so the same markup renders locally.

export interface CfImageOptions {
  width?: number;
  height?: number;
  quality?: number;
  format?: string;
  fit?: string;
  gravity?: string;
  dpr?: number;
  background?: string;
  rotate?: number;
  blur?: number;
  sharpen?: number;
  brightness?: number;
}

const CDN_CGI_IMAGE_PREFIX = "/cdn-cgi/image/";

/**
 * Parse a `/cdn-cgi/image/<options>/<source>` pathname into its options
 * and source reference. Returns null when the path isn't a cdn-cgi image
 * URL or is missing the source segment. The source is either an absolute
 * http(s) URL or a same-zone path (leading slash optional).
 */
export function parseCdnCgiImageUrl(
  pathname: string,
): { options: CfImageOptions; source: string } | null {
  if (!pathname.startsWith(CDN_CGI_IMAGE_PREFIX)) return null;
  const rest = pathname.slice(CDN_CGI_IMAGE_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const optionsStr = rest.slice(0, slash);
  let source = rest.slice(slash + 1);
  if (!source) return null;
  // An absolute source URL survives in the path as `https:/host/…` once
  // the URL parser collapses the authority's double slash — restore it.
  source = source.replace(/^(https?:)\/(?!\/)/, "$1//");
  if (!/^https?:\/\//.test(source)) source = decodeURIComponent(source);
  return { options: parseCfImageOptions(optionsStr), source };
}

const NAMED_QUALITY: Record<string, number> = {
  low: 35,
  "medium-low": 55,
  "medium-high": 75,
  high: 90,
};

export function parseCfImageOptions(optionsStr: string): CfImageOptions {
  const opts: CfImageOptions = {};
  for (const part of optionsStr.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!key || !value) continue;
    switch (key) {
      case "width":
      case "w":
        opts.width = parsePositiveInt(value);
        break;
      case "height":
      case "h":
        opts.height = parsePositiveInt(value);
        break;
      case "quality":
      case "q":
        opts.quality =
          value in NAMED_QUALITY
            ? NAMED_QUALITY[value]
            : clampInt(value, 1, 100);
        break;
      case "format":
        opts.format = value.toLowerCase();
        break;
      case "fit":
        opts.fit = value.toLowerCase();
        break;
      case "gravity":
      case "g":
        opts.gravity = value.toLowerCase();
        break;
      case "dpr":
        opts.dpr = Number(value) || undefined;
        break;
      case "background":
      case "bg":
        opts.background = decodeURIComponent(value);
        break;
      case "rotate":
        opts.rotate = Number(value) || undefined;
        break;
      case "blur":
        opts.blur = Number(value) || undefined;
        break;
      case "sharpen":
        opts.sharpen = Number(value) || undefined;
        break;
      case "brightness":
        opts.brightness = Number(value) || undefined;
        break;
      // Unsupported CF options (anim, metadata, trim, contrast, gamma,
      // onerror, …) are ignored — the transform still runs with the rest.
    }
  }
  return opts;
}

function parsePositiveInt(value: string): number | undefined {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function clampInt(value: string, min: number, max: number): number | undefined {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : undefined;
}

const IMAGE_CONTENT_TYPES: Record<string, string> = {
  webp: "image/webp",
  avif: "image/avif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  svg: "image/svg+xml",
};

export function imageContentType(format: string): string {
  return IMAGE_CONTENT_TYPES[format] ?? "application/octet-stream";
}

/** Best-effort image format from a path/URL extension (jpg→jpeg). */
export function formatFromPath(p: string): string {
  const ext = p.split(/[?#]/)[0].split(".").pop()?.toLowerCase() ?? "";
  if (ext === "jpg" || ext === "jpeg") return "jpeg";
  if (["png", "gif", "webp", "avif", "svg"].includes(ext)) return ext;
  return "jpeg"; // sensible default for extension-less / unknown sources
}

/** Image format from a Content-Type header, or null if not an image type. */
export function formatFromContentType(ct: string | null): string | null {
  if (!ct) return null;
  switch (ct.split(";")[0].trim().toLowerCase()) {
    case "image/jpeg":
      return "jpeg";
    case "image/png":
      return "png";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/avif":
      return "avif";
    case "image/svg+xml":
      return "svg";
    default:
      return null;
  }
}

/**
 * Resolve the output format for a transform. `format=auto` (or unset)
 * mirrors Cloudflare's content negotiation: prefer webp when the client
 * accepts it, otherwise keep the source format. We deliberately prefer
 * webp over avif even when avif is accepted — avif encoding is too slow
 * for a dev server's per-request path.
 */
export function resolveCfTargetFormat(
  requested: string | undefined,
  sourceFormat: string,
  accept: string | undefined,
): string {
  if (!requested || requested === "auto") {
    if (accept?.includes("image/webp")) return "webp";
    return sourceFormat;
  }
  return requested;
}

// Map Cloudflare's `fit` to sharp's. CF's default is `scale-down`, which
// fits within the box but never enlarges past the source.
function mapCfFit(fit: string): string {
  switch (fit) {
    case "cover":
    case "crop":
      return "cover";
    case "pad":
      return "contain";
    case "contain":
    case "scale-down":
    default:
      return "inside";
  }
}

function mapCfGravity(gravity: string | undefined): string | undefined {
  switch (gravity) {
    case "auto":
      return "attention";
    case "left":
    case "right":
    case "top":
    case "bottom":
      return gravity;
    case "center":
    case "centre":
      return "centre";
    default:
      return undefined; // coordinates / unknown → sharp default (centre)
  }
}

/**
 * Apply parsed cdn-cgi options to an image buffer using sharp. Returns
 * null when sharp isn't installed or the source is an SVG (served
 * untouched) — callers should fall back to the original bytes.
 */
export async function transformCfImage(
  input: ArrayBuffer | Uint8Array,
  sourceFormat: string,
  options: CfImageOptions,
  accept?: string,
): Promise<{ data: Uint8Array; format: string; contentType: string } | null> {
  if (sourceFormat === "svg") return null;
  const sharp = loadSharp();
  if (!sharp) return null;

  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let pipeline = sharp(bytes).rotate(); // honor EXIF orientation first

  if (options.rotate && options.rotate % 360 !== 0) {
    pipeline = pipeline.rotate(options.rotate);
  }

  const dpr = options.dpr && options.dpr > 0 ? Math.min(options.dpr, 3) : 1;
  const width = options.width ? Math.round(options.width * dpr) : undefined;
  const height = options.height ? Math.round(options.height * dpr) : undefined;
  if (width || height) {
    const fit = options.fit ?? "scale-down";
    pipeline = pipeline.resize(width, height, {
      fit: mapCfFit(fit),
      position: mapCfGravity(options.gravity),
      background: options.background,
      withoutEnlargement: fit === "scale-down",
    });
  }

  if (options.blur) {
    pipeline = pipeline.blur(Math.min(Math.max(options.blur, 0.3), 1000));
  }
  if (options.sharpen) {
    pipeline = pipeline.sharpen({ sigma: Math.min(options.sharpen, 10) });
  }
  if (options.brightness) {
    pipeline = pipeline.modulate({ brightness: options.brightness });
  }

  const targetFormat = resolveCfTargetFormat(options.format, sourceFormat, accept);
  const fmt = targetFormat === "jpg" ? "jpeg" : targetFormat;
  pipeline = pipeline.toFormat(
    fmt as keyof SharpFormatMap,
    options.quality != null ? { quality: options.quality } : undefined,
  );

  const data = await pipeline.toBuffer();
  return {
    data: new Uint8Array(data),
    format: targetFormat,
    contentType: imageContentType(targetFormat),
  };
}

// ── Post-render image processing ───────────────────────────────────────

type SharpFactory = (
  input: string | Buffer | Uint8Array | ArrayBuffer,
) => SharpPipeline;

let sharpFactory: SharpFactory | null | undefined;
let sharpResolveBase: string | undefined;

/**
 * Tell the image module which directory to resolve the optional `sharp`
 * dependency from — the consumer's project root. This matters because
 * pletivo is frequently symlinked / `bun link`ed into a project, in which
 * case a bare `require("sharp")` resolves against pletivo's *own* real
 * path (where sharp isn't installed) rather than the project's
 * node_modules. dev()/build() call this with their projectRoot.
 */
export function setSharpResolveBase(dir: string): void {
  if (dir !== sharpResolveBase) {
    sharpResolveBase = dir;
    sharpFactory = undefined; // force re-resolution against the new base
  }
}

/** Lazily require `sharp`, caching the result (and the failure). */
function loadSharp(): SharpFactory | null {
  if (sharpFactory !== undefined) return sharpFactory;
  // Prefer resolving from the consumer project (handles the symlinked
  // pletivo case), then fall back to a bare require against this module.
  const bases = [sharpResolveBase, process.cwd()].filter(Boolean) as string[];
  for (const base of bases) {
    try {
      const req = createRequire(path.join(base, "__pletivo_resolve__.js"));
      sharpFactory = req("sharp") as SharpFactory;
      return sharpFactory;
    } catch {
      // try the next base
    }
  }
  try {
    sharpFactory = require("sharp") as SharpFactory;
  } catch {
    sharpFactory = null;
  }
  return sharpFactory;
}

/** Whether `sharp` is importable — lets the dev server warn when a
 * cdn-cgi transform was requested but can't actually run. */
export function sharpAvailable(): boolean {
  return loadSharp() !== null;
}

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
        format: path.extname(entry.sourcePath).slice(1).toLowerCase(),
      });
    }
  }

  if (registered.size === 0) return 0;

  const sharp = loadSharp();
  if (!sharp) {
    console.warn(
      "  sharp not installed — images will be copied without optimization.",
    );
    console.warn('  Install sharp for resize + format conversion: bun add sharp');
  }

  let count = 0;
  for (const [, entry] of registered) {
    const outFile = path.join(distDir, entry.outputPath);
    await fs.mkdir(path.dirname(outFile), { recursive: true });

    try {
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
    } catch (e) {
      // Source missing/unreadable (e.g. a stray reference) — warn and
      // skip rather than aborting the whole build.
      console.warn(
        `  Warning: skipped image ${entry.sourcePath}: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  return count;
}

// Sharp types (minimal, to avoid importing @types/sharp)
interface SharpPipeline {
  rotate(angle?: number): SharpPipeline;
  resize(
    w?: number,
    h?: number,
    opts?: {
      fit?: string;
      position?: string;
      background?: string;
      withoutEnlargement?: boolean;
    },
  ): SharpPipeline;
  blur(sigma?: number): SharpPipeline;
  sharpen(opts?: { sigma?: number }): SharpPipeline;
  modulate(opts: {
    brightness?: number;
    saturation?: number;
    hue?: number;
    lightness?: number;
  }): SharpPipeline;
  toFormat(fmt: string, opts?: { quality?: number }): SharpPipeline;
  toBuffer(): Promise<Buffer>;
  toBuffer(opts: {
    resolveWithObject: true;
  }): Promise<{ data: Buffer; info: unknown }>;
}
type SharpFormatMap = Record<string, unknown>;
