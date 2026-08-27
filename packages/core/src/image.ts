/**
 * What both hosts have to agree on about an image: its size, its name, and its URL.
 *
 * The Bun host can open a file and hand it to sharp; a Worker Loader isolate can do
 * neither. What is left when you take the filesystem away is still most of the work —
 * reading a PNG header, naming `_astro/hero.<hash>.png`, deciding what `<Image>`
 * renders — and none of it is host-specific, so it lives here and runs on both.
 *
 * The seam is `ImageHost`, the same shape `ContentHost` has for collections: it
 * answers *what this host can do about the bytes*, never *what an image means*. The
 * Bun host installs one that queues a sharp transform; the Workers host installs
 * nothing, because an isolate cannot transform an image and says so by choosing a
 * passthrough service instead of pretending.
 */

import { withBase } from "@pletivo/runtime/base";
import { md5Hex } from "./md5";
import {
  resolveImageService,
  type ImageMetadata,
  type ImageProcessing,
  type ImageService,
  type ImageServiceConfig,
} from "./image-service";

export type { ImageMetadata };

// ── Types ──────────────────────────────────────────────────────────────

export interface GetImageResult {
  rawOptions: Record<string, unknown>;
  options: Record<string, unknown>;
  src: string;
  srcSet: { values: SrcSetValue[]; attribute: string };
  attributes: Record<string, unknown>;
}

export interface SrcSetValue {
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
  processing?: ImageProcessing;
}

export interface ImageDimensions {
  width: number;
  height: number;
  format: string;
}

/**
 * The part of an image pipeline only a host can perform.
 *
 * One method, because there is only one thing a host does that this module cannot:
 * remember that a file has to be produced. A host with no way to produce one — an
 * isolate — installs nothing and pairs that with a passthrough image service, so the
 * URL it emits names bytes that already exist.
 */
export interface ImageHost {
  registerTransform(entry: ImageTransformEntry): void;
}

let imageHost: ImageHost = { registerTransform: () => {} };

export function setImageHost(host: ImageHost): void {
  imageHost = host;
}

// ── Runtime state ──────────────────────────────────────────────────────

let imageMode: "dev" | "build" = "dev";

export function setImageMode(mode: "dev" | "build"): void {
  imageMode = mode;
}

export function getImageMode(): "dev" | "build" {
  return imageMode;
}

let imageService: ImageService = resolveImageService(undefined);

export function setImageService(service: ImageServiceConfig | undefined): void {
  imageService = resolveImageService(service);
}

export function getImageService(): ImageService {
  return imageService;
}

/** What `astro:assets` exports under this name. Read by user code, not by this module. */
export const imageConfig: Record<string, unknown> = {
  experimentalLayout: undefined,
  experimentalResponsiveImages: false,
  service: { entrypoint: "" },
  domains: [],
  remotePatterns: [],
};

// ── Paths, without a path module ───────────────────────────────────────
//
// `node:path` would resolve here, but the same code is bundled into the render
// isolate, where a Node shim is a dependency this does not need for two string
// operations. Both separators are handled so a Windows host names a file the way a
// POSIX one does.

/** The last segment of a path, with `extensionOf` removed when `stripExtension`. */
export function baseNameOf(file: string, stripExtension = false): string {
  const at = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
  const name = at === -1 ? file : file.slice(at + 1);
  if (!stripExtension) return name;
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? name : name.slice(0, dot);
}

/** A path's extension, dot included, or `""`. */
export function extensionOf(file: string): string {
  const name = baseNameOf(file);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot);
}

/**
 * Where an image is emitted, given its source path and the hash of its bytes.
 *
 * Content-addressed and therefore identical on both hosts for identical bytes, which
 * is what lets a page rendered in an isolate link to a file a Bun build wrote.
 */
export function imageOutputPath(sourcePath: string, contentHash: string): string {
  return `_astro/${baseNameOf(sourcePath, true)}.${contentHash}${extensionOf(sourcePath)}`;
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

/** What to serve an image as. Unknown formats stay bytes rather than claiming a type. */
export function imageContentType(format: string): string {
  return IMAGE_CONTENT_TYPES[format] ?? "application/octet-stream";
}

/** The content hash an output path carries: `md5(bytes)`, first 8 hex characters. */
export function imageContentHash(bytes: Uint8Array): string {
  return md5Hex(bytes).slice(0, 8);
}

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

// ── Pure JS image dimension reader ─────────────────────────────────────

/**
 * Width, height and format straight out of an image's header.
 *
 * Pure: it takes bytes, not a path. That is what lets the same reader serve a Bun
 * build reading a file and a Worker holding an upload it has never written down.
 * `label` only names the input in the error.
 */
export function readImageDimensions(
  input: ArrayBuffer | Uint8Array,
  label: string,
): ImageDimensions {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

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

  throw new Error(`Unsupported image format: ${label}`);
}

// ── getImage() ─────────────────────────────────────────────────────────

function computeHash(...parts: (string | number | undefined)[]): string {
  return md5Hex(parts.map(String).join("|")).slice(0, 8);
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

function parseOptionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function parseOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseQualityOption(value: unknown): number | string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") return value;
  return undefined;
}

function parseWidths(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const widths: number[] = [];
  for (const item of value) {
    const width = parseOptionalNumber(item);
    if (width && width > 0) widths.push(width);
  }
  return widths;
}

function getDefaultExport(value: unknown): unknown {
  if (typeof value === "object" && value !== null && "default" in value) {
    return value.default;
  }
  return value;
}

/** The dev server's URL for an original file. Build mode never reaches it. */
function devImageUrl(fsPath: string): string {
  return withBase(`/@image/${baseNameOf(fsPath)}?f=${fsPath}`);
}

export async function getImage(
  options: Record<string, unknown>,
): Promise<GetImageResult> {
  const src = getDefaultExport(await options.src);

  const metadata = isImageMetadata(src) ? src : null;
  const srcPath = metadata ? metadata.src : String(src ?? "");
  const fsPath = metadata?.fsPath;

  // Compute dimensions
  const origW = metadata?.width;
  const origH = metadata?.height;
  let width = parseOptionalNumber(options.width);
  let height = parseOptionalNumber(options.height);

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
  const requestedFormat = parseOptionalString(options.format);
  const format =
    requestedFormat ?? (sourceFormat === "svg" ? "svg" : "webp");
  const quality = parseQualityOption(options.quality);
  const fit = parseOptionalString(options.fit);

  // Compute deterministic output path
  const hash = computeHash(srcPath, width, height, format, quality);
  const outputFile = `_astro/${baseNameOf(srcPath, true)}.${hash}.${format}`;

  let finalSrc: string;
  let srcSet: { values: SrcSetValue[]; attribute: string } = {
    values: [],
    attribute: "",
  };

  if (imageMode === "build") {
    if (fsPath) {
      if (imageService.processing === "transform") {
        // On-disk source: optimize/copy it into _astro/ after render.
        imageHost.registerTransform({
          sourcePath: fsPath,
          outputPath: outputFile,
          width,
          height,
          format,
          quality,
          processing: "transform",
        });
      }
      finalSrc = imageService.getURL({
        src: srcPath,
        outputPath: outputFile,
        width,
        height,
        sourceFormat,
        outputFormat: format,
        requestedFormat,
        quality,
        fit,
      });
      if (imageService.supportsResponsive && sourceFormat !== "svg") {
        const widths = parseWidths(options.widths);
        if (widths.length) {
          const values = widths.map((responsiveWidth) => ({
            url: imageService.getURL({
              src: srcPath,
              outputPath: outputFile,
              width: responsiveWidth,
              sourceFormat,
              outputFormat: format,
              requestedFormat,
              quality,
              fit,
            }),
            descriptor: `${responsiveWidth}w`,
          }));
          srcSet = {
            values,
            attribute: values.map((v) => `${v.url} ${v.descriptor}`).join(", "),
          };
        }
      }
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
    finalSrc = fsPath ? devImageUrl(fsPath) : srcPath;
  }

  // Build HTML attributes — only include image-relevant ones
  const attributes: Record<string, unknown> = {};
  if (width) attributes.width = width;
  if (height) attributes.height = height;
  attributes.loading = options.loading ?? "lazy";
  attributes.decoding = options.decoding ?? "async";
  if (options.alt !== undefined) attributes.alt = options.alt;

  // Pass through data-* and common HTML attributes.
  for (const [k, v] of Object.entries(options)) {
    if (
      k.startsWith("data-") ||
      k === "class" ||
      k === "style" ||
      k === "id" ||
      k === "role" ||
      k === "sizes" ||
      k === "fetchpriority"
    ) {
      attributes[k] = v;
    }
  }

  return {
    rawOptions: { ...options, src },
    options: { ...options, src, width, height, format },
    src: finalSrc,
    srcSet,
    attributes,
  };
}
