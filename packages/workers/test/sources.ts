/**
 * Reading a fixture the way a host takes it: text one side, bytes the other.
 *
 * Shared by both parity harnesses. A Worker's sources arrive as strings and its
 * images do not, so `renderPage` takes two maps and so does this.
 */

import path from "node:path";
import { Glob } from "bun";

/** Directories that hold build products or dependencies, not sources. */
export const SKIPPED = new Set(["node_modules", "dist", "tmp", ".astro", ".wrangler"]);

/** Extensions read as bytes. `.svg` is text and is deliberately left on that side. */
const BINARY_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico"]);

export interface FixtureSources {
  text: Map<string, string>;
  binary: Map<string, Uint8Array>;
}

export async function readSources(dir: string): Promise<FixtureSources> {
  const text = new Map<string, string>();
  const binary = new Map<string, Uint8Array>();
  for await (const rel of new Glob("**/*").scan({ cwd: dir, dot: false })) {
    if (rel.split("/").some((segment) => SKIPPED.has(segment))) continue;
    const file = Bun.file(path.join(dir, rel));
    if (BINARY_EXTENSIONS.has(path.extname(rel).toLowerCase())) binary.set(rel, await file.bytes());
    else text.set(rel, await file.text());
  }
  return { text, binary };
}

/**
 * Every `src`/`srcset` URL in rendered HTML that this host is expected to serve.
 *
 * `public/` references are deliberately not among them: those are the host's own to
 * serve and are hashed by a separate mechanism (`docs/todos/017 §2`).
 */
export function imageUrls(html: string): string[] {
  const urls = new Set<string>();
  for (const match of html.matchAll(/(?:src|srcset)="([^"]+)"/g)) {
    // A `srcset` separates candidates with a comma, and a `/cdn-cgi/image/` URL
    // separates its *options* with one too — so split only where a new URL begins.
    for (const candidate of match[1].split(/,\s*(?=\/|https?:)/)) {
      const url = candidate.trim().split(/\s+/)[0];
      if (url.startsWith("/_astro/") || url.startsWith("/cdn-cgi/image/")) urls.add(url);
    }
  }
  return [...urls];
}

export function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
