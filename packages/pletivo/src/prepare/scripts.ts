/** The processed `<script>` blocks of an `.astro` file: what Astro bundles for the browser. */

import { transform } from "@astrojs/compiler";
import { prepareFailure } from "./error";

/**
 * Bodies of the scripts Astro processes, in source order. `is:inline` scripts and
 * scripts with other attributes are not among them; the compiler decides, not a regex.
 */
export async function processedScripts(file: string, source: string): Promise<string[]> {
  const result = await transform(source, { filename: file, sourcemap: false });
  const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === 1);
  if (errors.length > 0) {
    throw prepareFailure(file, "scan", errors.map((error) => error.text).join("; "));
  }
  const scripts: string[] = [];
  for (const script of result.scripts) {
    if (script.type === "inline") scripts.push(script.code);
  }
  return scripts;
}
