/**
 * `?url` import support.
 *
 * Astro resolves `import href from "./foo.js?url"` to the URL *string* of the
 * emitted asset (the file is copied as-is, not bundled), so markup like
 * `<script src={href}>` points at a real served file. Pletivo otherwise lets
 * Bun load `foo.js?url` as a module and fails on the missing default export.
 *
 * In dev the file is served raw from `/@asset/` (mirrors the `/@image/` route);
 * in build it is content-hashed under `_astro/` and emitted to dist.
 */

import path from "path";
import { withBase } from "./base";
import { recordRuntimeDep } from "./incremental/dep-tracker";

let mode: "dev" | "build" = "dev";

/** outputPath (e.g. `_astro/contact-form.ab12cd34.js`) → absolute source path. */
const registry = new Map<string, string>();

export function setUrlAssetMode(m: "dev" | "build"): void {
  mode = m;
  registry.clear();
}

/** Files imported via `?url`, to be copied into dist during build. */
export function getUrlAssets(): Map<string, string> {
  return new Map(registry);
}

export function clearUrlAssets(): void {
  registry.clear();
}

/**
 * Register a `?url`-imported file and return the public URL string it resolves
 * to. Dev serves the original file from `/@asset/?f=<path>`; build content-hashes
 * it under `_astro/` and records it for emission by `processUrlAssets()`.
 */
export async function registerUrlAsset(fsPath: string): Promise<string> {
  recordRuntimeDep(fsPath);

  if (mode === "dev") {
    return withBase(`/@asset/${path.basename(fsPath)}?f=${fsPath}`);
  }

  const buffer = await Bun.file(fsPath).arrayBuffer();
  const hasher = new Bun.CryptoHasher("md5");
  hasher.update(buffer);
  const hash = hasher.digest("hex").slice(0, 8);

  const ext = path.extname(fsPath);
  const base = path.basename(fsPath, ext);
  const outputPath = `_astro/${base}.${hash}${ext}`;

  registry.set(outputPath, fsPath);
  return withBase(`/${outputPath}`);
}
