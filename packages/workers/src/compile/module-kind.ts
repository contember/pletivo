import type { ArtifactModuleKind } from "@pletivo/core/artifact";

/** Compiled to JavaScript by `@astrojs/compiler`. */
export const COMPILED = ".astro";
/** Already JavaScript: carried into the bundle untouched. */
const VERBATIM = [".js", ".mjs"];
/** Resolvable as a style edge and represented by an empty Loader module. */
const EMPTY = [".css"];

/** Whether a project path becomes a module the isolate can run. */
export function isExecutableModule(file: string): boolean {
  const kind = projectModuleKind(file);
  return kind !== null && kind !== "css";
}

export function projectModuleKind(file: string): ArtifactModuleKind | null {
  const extension = extensionOf(file);
  if (extension === COMPILED) return "astro";
  if (VERBATIM.includes(extension)) return "js";
  if (extension === ".ts" || extension === ".mts" || extension === ".cts") return "ts";
  if (extension === ".tsx") return "tsx";
  if (extension === ".jsx") return "jsx";
  if (extension === ".json") return "json";
  if (EMPTY.includes(extension)) return "css";
  return null;
}

export function extensionOf(file: string): string {
  const at = file.lastIndexOf(".");
  const slash = file.lastIndexOf("/");
  return at === -1 || at < slash ? "" : file.slice(at).toLowerCase();
}
