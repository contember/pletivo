import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AstroConfig } from "./types";

/**
 * Whether an Astro project compiles `.astro` with `compact`: its `compressHTML`,
 * or Astro's default `true`. Without an Astro config (a pletivo-native project)
 * it is `undefined`, leaving the compiler's own default (off).
 */
export function resolveCompressHTML(config: AstroConfig | undefined): boolean | undefined {
  if (!config) return undefined;
  const configured = config.compressHTML;
  if (configured === undefined) return true;
  if (typeof configured === "boolean") return configured;
  throw new Error(invalidCompressHTML(configured));
}

export function invalidCompressHTML(value: unknown): string {
  return `compressHTML ${JSON.stringify(value)} is not a boolean`;
}

function normalizePath(id: string): string {
  return path.posix.normalize(path.sep === "\\" ? id.replaceAll("\\", "/") : id);
}

/**
 * The compiler's `normalizedFilename`, as Astro computes it: root-relative with a
 * leading `/` inside `root`, else the normalized absolute path. The compiler
 * hashes it into the component's scope id, so it must not depend on the cwd.
 */
export function normalizeFilename(filename: string, root: URL): string {
  const normalizedFilename = normalizePath(filename);
  const normalizedRoot = normalizePath(fileURLToPath(root));
  if (normalizedFilename.startsWith(normalizedRoot)) {
    return normalizedFilename.slice(normalizedRoot.length - 1);
  }
  return normalizedFilename;
}

/**
 * `normalizeFilename` for a host that knows a file only by its root-relative path
 * (the Workers host): the same value for a file inside the root. A path that leaves
 * the root has no absolute form there, so it stays relative and its scope id differs.
 */
export function normalizeRootRelativeFilename(relative: string): string {
  const normalized = path.posix.normalize(relative);
  if (normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) return normalized;
  return `/${normalized}`;
}
