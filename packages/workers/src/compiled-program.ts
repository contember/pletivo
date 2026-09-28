import type { ModuleId } from "@pletivo/core/artifact";

export interface ExecutableEntry {
  moduleId: ModuleId;
  executionName: string;
}

export interface ProgramContentRequirement {
  /** Loader name of `content.config.*`, or null when the project defines none. */
  configExecutionName: string | null;
}

export interface ProgramEnvRequirement {
  /** Null means the corresponding `astro:env` module is not reached. */
  client: string[] | null;
  server: string[] | null;
}

/** Features the generated isolate entry must install. */
export interface ExecutableRequirements {
  content: ProgramContentRequirement | null;
  images: boolean;
  importMetaEnv: boolean;
  env: ProgramEnvRequirement | null;
}

/** Loader-ready output; sources and CSS graph stay outside it. */
export interface ExecutableProgram {
  mainModule: string;
  modules: Record<string, string>;
  entries: ExecutableEntry[];
  requirements: ExecutableRequirements;
}

export interface OrderedExecutionEdge {
  importer: ModuleId;
  target: ModuleId;
}

export interface OrderedStyleEdge {
  importer: ModuleId;
  target: ModuleId;
}

export interface ResolvedStyleBlock {
  global: boolean;
  css: string;
}

export interface ResolvedModuleStyles {
  moduleId: ModuleId;
  scope: string;
  blocks: ResolvedStyleBlock[];
}

/** CSS inputs retain the same source-order graph as executable compilation. */
export interface ResolvedStyleGraph {
  modules: ModuleId[];
  executionEdges: OrderedExecutionEdge[];
  styleEdges: OrderedStyleEdge[];
  styles: ResolvedModuleStyles[];
}
