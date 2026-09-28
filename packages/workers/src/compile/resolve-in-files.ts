import { extensionOf } from "./module-kind.ts";

/**
 * Extensions tried when a specifier names no file map key on its own, in the order
 * Bun's resolver tries them — so a project that runs on the Bun host resolves the same
 * way here.
 */
const IMPLIED_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".astro", ".mts", ".cts"];

/**
 * What a resolved specifier actually names in the file map.
 *
 * `import Layout from "../components/Layout"` is ordinary in a TypeScript project and
 * names no key; so is `import { x } from "./util.js"` when the file on disk is
 * `util.ts`, which is what `moduleResolution: nodenext` asks authors to write. Both
 * resolve off the filesystem on the Bun host.
 *
 * Every caller that walks the graph goes through here, so the module rewriting, the
 * import edges and the CSS cascade order all agree on which file was meant.
 */
export function resolveInFiles(
  resolved: string,
  files: ReadonlyMap<string, string>,
): string | null {
  if (files.has(resolved)) return resolved;
  const extension = extensionOf(resolved);
  // `./util.js` naming a `util.ts`: TypeScript's own convention, and it has to be
  // tried before the implied-extension pass or `util.js.ts` would be looked for first.
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
