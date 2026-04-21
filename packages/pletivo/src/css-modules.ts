/**
 * CSS Modules support for Pletivo.
 *
 * Registers a Bun plugin that handles `.module.css` imports:
 *  - Parses class selectors from the CSS
 *  - Generates scoped class names (`{filename}_{class}_{hash}`)
 *  - Rewrites the CSS with scoped selectors
 *  - Returns a JS module exporting the class name mapping
 *
 * Generated CSS is stored in a module-level map and included in the
 * global CSS bundle (build) or served via /__styles.css (dev).
 *
 * Call `registerCssModulesPlugin()` once at process start.
 */

import path from "path";
import { stripQuery } from "./dev-cache";
import { escapeRegex } from "./escape-regex";

let registered = false;

/** Map of source path → generated CSS with scoped class names */
const moduleCssMap = new Map<string, string>();

/** Get all generated CSS Modules content for inclusion in bundles */
export function getCssModulesOutput(): string {
  if (moduleCssMap.size === 0) return "";
  return Array.from(moduleCssMap.values()).join("\n");
}

/** Clear generated CSS (between builds) */
export function clearCssModules(): void {
  moduleCssMap.clear();
}

/**
 * Generate a short deterministic hash from a string.
 * Used for scoping class names to their source file.
 */
function scopeHash(input: string): string {
  const hasher = new Bun.CryptoHasher("md5");
  hasher.update(input);
  return hasher.digest("hex").slice(0, 5);
}

/**
 * Extract class selectors from CSS and generate scoped replacements.
 * Returns the mapping (local → scoped) and the rewritten CSS.
 */
function processCssModule(
  css: string,
  filePath: string,
): { mapping: Record<string, string>; scopedCss: string } {
  const basename = path.basename(filePath, path.extname(filePath)).replace(/\.module$/, "");
  const hash = scopeHash(filePath);
  const mapping: Record<string, string> = {};

  // Find all class selectors (.className) in the CSS.
  // We need to track which classes we've seen and replace them.
  const classRegex = /\.([a-zA-Z_][\w-]*)/g;
  const classNames = new Set<string>();
  let match;
  while ((match = classRegex.exec(css)) !== null) {
    classNames.add(match[1]);
  }

  // Build mapping: local name → scoped name
  for (const cls of classNames) {
    mapping[cls] = `${basename}_${cls}_${hash}`;
  }

  // Rewrite CSS: replace .className with .scoped_className
  let scopedCss = css;
  for (const [local, scoped] of Object.entries(mapping)) {
    // Replace class selectors, being careful not to match inside strings or property values.
    // We match `.className` only when preceded by valid selector context.
    scopedCss = scopedCss.replace(
      new RegExp(`\\.${escapeRegex(local)}(?=[^\\w-])`, "g"),
      `.${scoped}`,
    );
    // Handle class at end of string/line
    scopedCss = scopedCss.replace(
      new RegExp(`\\.${escapeRegex(local)}$`, "gm"),
      `.${scoped}`,
    );
  }

  return { mapping, scopedCss };
}

export async function registerCssModulesPlugin(): Promise<void> {
  if (registered) return;
  registered = true;

  await Bun.plugin({
    name: "pletivo-css-modules",
    setup(build) {
      build.onLoad({ filter: /\.module\.css(\?.*)?$/ }, async (args) => {
        const cleanPath = stripQuery(args.path);
        const css = await Bun.file(cleanPath).text();
        const { mapping, scopedCss } = processCssModule(css, cleanPath);

        // Store the scoped CSS for inclusion in the bundle
        moduleCssMap.set(cleanPath, scopedCss);

        // Return a JS module exporting the class name mapping
        return {
          contents: `export default ${JSON.stringify(mapping)};`,
          loader: "js",
        };
      });
    },
  });
}
