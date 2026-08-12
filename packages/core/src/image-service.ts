import { withBase } from "@pletivo/runtime/base";

export type ImageProcessing = "transform" | "passthrough";

export interface ImageServiceUrlOptions {
  src: string;
  outputPath: string;
  width?: number;
  height?: number;
  sourceFormat: string;
  outputFormat: string;
  requestedFormat?: string;
  quality?: number | string;
  fit?: string;
}

export interface ImageService {
  name: string;
  cacheKey?: string;
  processing: ImageProcessing;
  supportsResponsive?: boolean;
  getURL(options: ImageServiceUrlOptions): string;
}

export type BuiltInImageServiceName = "sharp" | "passthrough" | "cloudflare";

export type ImageServiceConfig =
  | BuiltInImageServiceName
  | ImageService;

export const IMAGE_SERVICE_ENV = "PLETIVO_IMAGE_SERVICE";

export interface CloudflareImageServiceOptions {
  format?: string;
  onerror?: "redirect";
}

export interface CdnCgiImageUrlOptions {
  width?: number;
  height?: number;
  quality?: number;
  format?: string;
  fit?: string;
  onerror?: "redirect";
}

export function sharpImageService(): ImageService {
  return {
    name: "sharp",
    cacheKey: "sharp",
    processing: "transform",
    getURL(options) {
      return withBase(`/${options.outputPath}`);
    },
  };
}

export function passthroughImageService(): ImageService {
  return {
    name: "passthrough",
    cacheKey: "passthrough",
    processing: "passthrough",
    getURL(options) {
      return options.src;
    },
  };
}

export function cloudflareImageService(
  options: CloudflareImageServiceOptions = {},
): ImageService {
  const defaultFormat = options.format ?? "auto";
  const defaultOnError = options.onerror ?? "redirect";
  return {
    name: "cloudflare",
    cacheKey: `cloudflare:${defaultFormat}:${defaultOnError}`,
    processing: "passthrough",
    supportsResponsive: true,
    getURL(transform) {
      if (transform.sourceFormat === "svg") return transform.src;
      return buildCdnCgiImageUrl(transform.src, {
        width: transform.width,
        height: transform.height,
        quality: normalizeCloudflareQuality(transform.quality),
        format: transform.requestedFormat ?? defaultFormat,
        fit: transform.fit,
        onerror: defaultOnError,
      });
    },
  };
}

export function resolveImageService(
  service: ImageServiceConfig | undefined,
): ImageService {
  if (!service || service === "sharp") return sharpImageService();
  if (service === "passthrough") return passthroughImageService();
  if (service === "cloudflare") return cloudflareImageService();
  return service;
}

export function imageServiceConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): BuiltInImageServiceName | undefined {
  const raw = env[IMAGE_SERVICE_ENV]?.trim().toLowerCase();
  if (!raw) return undefined;
  switch (raw) {
    case "sharp":
    case "optimize":
      return "sharp";
    case "passthrough":
      return "passthrough";
    case "cloudflare":
    case "cf":
    case "cf-resize":
    case "cloudflare-resize":
    case "cloudflare-resizing":
    case "cdn-cgi":
      return "cloudflare";
    default:
      throw new Error(
        `Invalid ${IMAGE_SERVICE_ENV}=${JSON.stringify(raw)}. Expected "sharp", "passthrough", or "cloudflare".`,
      );
  }
}

export function buildCdnCgiImageUrl(
  source: string,
  options: CdnCgiImageUrlOptions,
): string {
  const parts: string[] = [];
  if (options.onerror) parts.push(`onerror=${options.onerror}`);
  if (options.width) parts.push(`width=${options.width}`);
  if (options.height) parts.push(`height=${options.height}`);
  if (options.quality != null) parts.push(`quality=${options.quality}`);
  parts.push(`format=${options.format ?? "auto"}`);
  if (options.fit) parts.push(`fit=${options.fit}`);
  const src = /^https?:\/\//.test(source) ? source : source.replace(/^\/+/, "");
  return `/cdn-cgi/image/${parts.join(",")}/${src}`;
}

const NAMED_CLOUDFLARE_QUALITY: Record<string, number> = {
  low: 35,
  "medium-low": 55,
  "medium-high": 75,
  high: 90,
};

function normalizeCloudflareQuality(
  quality: number | string | undefined,
): number | undefined {
  if (typeof quality === "number") return quality;
  if (typeof quality === "string") return NAMED_CLOUDFLARE_QUALITY[quality];
  return undefined;
}
