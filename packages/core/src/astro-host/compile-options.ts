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
  throw new Error(`astro.config: ${invalidCompressHTML(configured)}`);
}

/** Why a `compressHTML` is rejected; `prepare` reports it with `astro.config` as the source. */
export function invalidCompressHTML(value: unknown): string {
  return `compressHTML ${JSON.stringify(value)} is not a boolean`;
}

function normalizePath(id: string): string {
  return path.posix.normalize(path.sep === "\\" ? id.replaceAll("\\", "/") : id);
}

/**
 * The compiler's `normalizedFilename`, hashed into the scope id. Inside `root`, Astro's
 * root-relative `/…`; outside, the root-relative `../…` the Workers host also derives,
 * where Astro hashes the absolute path, which depends on where the checkout lives.
 */
export function normalizeFilename(filename: string, root: URL): string {
  const normalizedFilename = normalizePath(filename);
  // `.href`: under workerd's types the global `URL` is not `node:url`'s.
  const rootPath = fileURLToPath(root.href);
  const normalizedRoot = normalizePath(rootPath);
  if (normalizedFilename.startsWith(normalizedRoot)) {
    return normalizedFilename.slice(normalizedRoot.length - 1);
  }
  return normalizeRootRelativeFilename(normalizePath(path.relative(rootPath, filename)));
}

/**
 * `normalizeFilename` for a host that knows a file only by its root-relative path
 * (the Workers host): a path inside the root gains a leading `/`, a path that leaves
 * the root keeps its `../` form, as `normalizeFilename` gives for the same file.
 */
export function normalizeRootRelativeFilename(relative: string): string {
  const normalized = path.posix.normalize(relative);
  if (normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) return normalized;
  return `/${normalized}`;
}
