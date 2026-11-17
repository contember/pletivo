/** What `prepare` reads off an `.astro` file's compile: its browser scripts and the islands it hydrates. */

import { transform } from "@astrojs/compiler";
import type { AstroIslandComponent } from "../astro-islands-bundle";
import { resolveComponentPath } from "../astro-plugin";
import { prepareFailure } from "./error";

export interface AstroSourceFacts {
  /**
   * Bodies of the scripts Astro processes, in source order. `is:inline` scripts and
   * scripts with other attributes are not among them; the compiler decides, not a regex.
   */
  scripts: string[];
  /**
   * Each `client:*` component, `client:only` included, as the Bun host's compile names it:
   * the import as written, made absolute. Its island URL hashes that spelling.
   */
  hydrated: AstroIslandComponent[];
}

export async function astroSourceFacts(file: string, source: string): Promise<AstroSourceFacts> {
  const result = await transform(source, {
    filename: file,
    sourcemap: false,
    resolvePath: async (specifier) => resolveComponentPath(specifier, file),
  });
  const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === 1);
  if (errors.length > 0) {
    throw prepareFailure(file, "scan", errors.map((error) => error.text).join("; "));
  }
  const scripts: string[] = [];
  for (const script of result.scripts) {
    if (script.type === "inline") scripts.push(script.code);
  }
  const hydrated = [...result.hydratedComponents, ...result.clientOnlyComponents].map((component) => ({
    // Decoded, as the rendered `client:component-path` is.
    componentPath: decodeURI(component.resolvedPath),
    exportName: component.exportName,
  }));
  return { scripts, hydrated };
}

/** The processed `<script>` blocks of an `.astro` file: what Astro bundles for the browser. */
export async function processedScripts(file: string, source: string): Promise<string[]> {
  return (await astroSourceFacts(file, source)).scripts;
}
