/**
 * `public/`, served the way Astro's dev server serves it: exact bytes, before any page
 * route, under the URL path the file has inside `public/`.
 */

import type { ProjectSnapshot } from "./project-store.ts";

/** Astro's `publicDir`; `pletivo prepare` refuses any other. */
export const PUBLIC_DIR = "public";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".rss": "application/rss+xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".pdf": "application/pdf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".zip": "application/zip",
  ".wasm": "application/wasm",
};

/** What a `public/` file is served as. Unknown types are an octet stream, never a guess. */
export function publicContentType(path: string): string {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  const extension = dot > slash ? path.slice(dot).toLowerCase() : "";
  return CONTENT_TYPES[extension] ?? "application/octet-stream";
}

/**
 * The project key of the `public/` file a URL pathname names, or `null` when it names
 * none: no traversal, no empty or dot segments, no encoded separators.
 */
export function publicKey(pathname: string, rootDir: string): string | null {
  if (!pathname.startsWith("/") || pathname.endsWith("/")) return null;
  const segments: string[] = [];
  for (const raw of pathname.slice(1).split("/")) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (segment === "" || segment.startsWith(".") || /[/\\\0]/.test(segment)) return null;
    segments.push(segment);
  }
  const prefix = rootDir === "" ? PUBLIC_DIR : `${rootDir}/${PUBLIC_DIR}`;
  return `${prefix}/${segments.join("/")}`;
}

/** The response for a `public/` file, or `null` when the snapshot has no such file. */
export function publicFileResponse(
  request: Request,
  pathname: string,
  snapshot: ProjectSnapshot,
  rootDir: string,
): Response | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const key = publicKey(pathname, rootDir);
  if (key === null || snapshot.readBytes === undefined) return null;
  const bytes = snapshot.readBytes(key);
  if (bytes === undefined) return null;
  const headers = new Headers({
    "content-type": publicContentType(key),
    "content-length": String(bytes.byteLength),
    // Unhashed names: the next request must see an edit.
    "cache-control": "no-cache",
  });
  return new Response(request.method === "HEAD" ? null : bytes, { headers });
}
