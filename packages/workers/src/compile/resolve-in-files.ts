import type { ProjectFiles } from "../project-store.ts";
import { extensionOf } from "./module-kind.ts";

/** Extensions tried when a specifier names no key, in Bun's resolver order so both hosts agree. */
const IMPLIED_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".astro", ".mts", ".cts"];

/**
 * What a resolved specifier names in the file map: extensionless and `./x.js`-for-`x.ts`
 * specifiers included. Every graph walker uses this so they agree on the file.
 */
export function resolveInFiles(
  resolved: string,
  files: ProjectFiles,
): string | null {
  if (files.has(resolved)) return resolved;
  const extension = extensionOf(resolved);
  // Before the implied-extension pass, or `util.js.ts` would be looked for first.
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") {
    const stem = resolved.slice(0, -extension.length);
    for (const candidate of [".ts", ".tsx", ".mts", ".cts"]) {
      if (files.has(stem + candidate)) return stem + candidate;
    }
  }
  if (extension === "") {
    for (const candidate of IMPLIED_EXTENSIONS) {
      if (files.has(resolved + candidate)) return resolved + candidate;
    }
    for (const candidate of IMPLIED_EXTENSIONS) {
      if (files.has(`${resolved}/index${candidate}`)) return `${resolved}/index${candidate}`;
    }
  }
  return null;
}
