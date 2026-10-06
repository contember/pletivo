/** Reads a `CompiledProject` by project path or ModuleId, as the tests assert on it. */

import type { ModuleId } from "@pletivo/core/artifact";
import { executionNameForModuleId, projectModuleId } from "../src/artifact.ts";
import type { ResolvedModuleStyles } from "../src/compiled-program.ts";
import type { CompiledProject } from "../src/compile-project.ts";

/** A project path, or a ModuleId when it carries a namespace (`npm:`, `virtual:`, `generated:`…). */
export type ModuleRef = string;

function idOf(ref: ModuleRef): ModuleId {
  return /^[a-z]+:/.test(ref) ? ref : projectModuleId(ref);
}

/** The Loader name a module is bundled under. */
export function nameOf(ref: ModuleRef): string {
  return executionNameForModuleId(idOf(ref));
}

/** The module's bundled code, or `undefined` when the walk never reached it. */
export function codeOf(project: CompiledProject, ref: ModuleRef): string | undefined {
  return project.program.modules[nameOf(ref)];
}

export function hasModule(project: CompiledProject, ref: ModuleRef): boolean {
  return codeOf(project, ref) !== undefined;
}

/** What `ref` imports to execute, in source order, without repeats. */
export function importsOf(project: CompiledProject, ref: ModuleRef): ModuleRef[] {
  return targetsOf(project.styleGraph.executionEdges, idOf(ref));
}

/** The stylesheets `ref` imports, in source order, without repeats. */
export function stylesheetsOf(project: CompiledProject, ref: ModuleRef): ModuleRef[] {
  return targetsOf(project.styleGraph.styleEdges, idOf(ref));
}

export function stylesOf(project: CompiledProject, ref: ModuleRef): ResolvedModuleStyles | undefined {
  const id = idOf(ref);
  return project.styleGraph.styles.find((styles) => styles.moduleId === id);
}

function targetsOf(
  edges: readonly { importer: ModuleId; target: ModuleId }[],
  importer: ModuleId,
): ModuleRef[] {
  const targets = edges.filter((edge) => edge.importer === importer).map((edge) => refOf(edge.target));
  return [...new Set(targets)];
}

function refOf(id: ModuleId): ModuleRef {
  return id.startsWith("project:") ? id.slice("project:".length) : id;
}
