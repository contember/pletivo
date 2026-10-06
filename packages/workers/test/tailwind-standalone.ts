/**
 * Tailwind over a whole file map, with no page and no module graph: what the parity
 * harness compares against `pletivo build`, which compiles one stylesheet per project.
 */

import type { ModuleId } from "@pletivo/core/artifact";
import { findTailwindEntry, type StylesheetSource } from "../src/project-css.ts";
import { extractCandidates, type CompileTailwindOptions } from "../src/tailwind.ts";

const CSS = ".css";
const CSS_MODULE = ".module.css";

/** The stylesheet under `srcDir` that imports Tailwind, picked as page assembly picks one. */
export function tailwindEntry(options: { files: ReadonlyMap<string, string>; srcDir: string }): string | null {
  const prefix = options.srcDir === "" ? "" : `${options.srcDir}/`;
  const sources: StylesheetSource[] = [];
  for (const [file, content] of options.files) {
    if (!file.startsWith(prefix) || !file.endsWith(CSS) || file.endsWith(CSS_MODULE)) continue;
    sources.push({ moduleId: file, content });
  }
  return findTailwindEntry(sources)?.moduleId ?? null;
}

/** Every candidate in the project, from the virtual file map rather than a filesystem walk. */
export function scanCandidates(files: ReadonlyMap<string, string>): string[] {
  const all = new Set<string>();
  for (const [file, content] of files) {
    if (file.endsWith(CSS)) continue;
    for (const candidate of extractCandidates(content)) all.add(candidate);
  }
  return [...all].sort();
}

/**
 * Targets for a caller with no module graph: every `@import` resolves by path, and
 * Tailwind's own specifiers name the embedded stylesheets directly.
 */
export const STANDALONE_TARGETS: Pick<CompileTailwindOptions, "styleTargets" | "embeddedTargets"> = {
  styleTargets: new Map<ModuleId, ModuleId[]>(),
  embeddedTargets: new Map([
    ["tailwindcss", "tailwindcss"],
    ["tailwindcss/preflight", "tailwindcss/preflight"],
    ["tailwindcss/theme", "tailwindcss/theme"],
    ["tailwindcss/utilities", "tailwindcss/utilities"],
  ]),
};
