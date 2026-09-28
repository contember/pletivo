import type { ModuleId } from "@pletivo/core/artifact";
import type { CompiledFile } from "../compile-cache.ts";
import { HOST_ALIASES } from "../host-aliases.ts";
import { rewriteImports } from "../rewrite-imports.ts";
import type { ImportResolver } from "./resolve.ts";
import {
  UnsupportedFileError,
  unresolvedImport,
  type ResolutionUse,
  type SourceModule,
} from "./source-module.ts";
import type { CompileWalk } from "./walk-state.ts";

/** The part of a module's compile a cache hit still pays: resolve, record edges, emit rewritten code. */
export async function linkModule(
  walk: CompileWalk,
  resolver: ImportResolver,
  module: SourceModule,
  entry: CompiledFile,
): Promise<void> {
  const { legacyKey, executionName } = module;
  if (entry.importMetaEnv) walk.usesImportMetaEnv = true;
  if (entry.styles !== null) walk.styles.set(legacyKey, entry.styles);
  const bySpecifier = new Map<string, ResolutionUse>();
  const executionTargets: string[] = [];
  const styleTargets: string[] = [];
  const seenExecution = new Set<string>();
  const seenStyles = new Set<string>();
  for (const specifier of entry.specifiers) {
    let use = bySpecifier.get(specifier);
    if (use === undefined) {
      use = await resolver.resolve(module, specifier);
      bySpecifier.set(specifier, use);
      walk.graphEdges.push(use.edge);
    }
    if (use.edge.target.kind === "external") {
      const alias = HOST_ALIASES.get(use.edge.target.specifier);
      if (alias?.kind === "env") {
        walk.useEnv(use.edge.target.specifier, entry.envNames?.get(specifier) ?? []);
      }
    }
    if (use.targetLegacyKey === null) continue;
    if (use.edge.kind === "style") {
      if (!seenStyles.has(use.targetLegacyKey)) styleTargets.push(use.targetLegacyKey);
      seenStyles.add(use.targetLegacyKey);
    } else {
      if (!seenExecution.has(use.targetLegacyKey)) executionTargets.push(use.targetLegacyKey);
      seenExecution.add(use.targetLegacyKey);
    }
  }
  walk.imports.set(legacyKey, executionTargets);
  walk.cssImports.set(legacyKey, styleTargets);
  const compiledCode = module.kind === "astro"
    ? replaceAstroTrackingId(entry.code ?? entry.source, module.compilePath, module.id)
    : (entry.code ?? entry.source);
  walk.modules[executionName] = rewriteImports(compiledCode, {
    importer: module.compilePath,
    resolve(_resolved, specifier) {
      const use = bySpecifier.get(specifier);
      if (use === undefined) {
        throw unresolvedImport(module, specifier, "rewrite did not see the canonical resolution");
      }
      return use.rewritten;
    },
  });
}

/** A resolvable stub: no code to compile and nothing to cache, only its `@import` edges. */
export async function linkStylesheet(
  walk: CompileWalk,
  resolver: ImportResolver,
  module: SourceModule,
): Promise<void> {
  const targets: string[] = [];
  const seen = new Set<string>();
  for (const specifier of collectCssSpecifiers(module.source)) {
    const use = await resolver.resolve(module, specifier);
    walk.graphEdges.push(use.edge);
    if (use.edge.kind !== "style" || use.targetLegacyKey === null) {
      throw unresolvedImport(module, specifier, "CSS @import must resolve to a CSS module");
    }
    if (!seen.has(use.targetLegacyKey)) targets.push(use.targetLegacyKey);
    seen.add(use.targetLegacyKey);
  }
  walk.imports.set(module.legacyKey, []);
  walk.cssImports.set(module.legacyKey, targets);
  walk.modules[module.executionName] = "export {};\n";
}

function collectCssSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const pattern = /@import\s+(?:url\(\s*)?["']([^"']+)["']\s*\)?/g;
  for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  return specifiers;
}

/** Keep the compiler filename for scope hashing, but expose logical identity at render time. */
function replaceAstroTrackingId(code: string, compilePath: string, moduleId: ModuleId): string {
  const field = `, ${compilerString(compilePath)}, undefined);`;
  const call = code.lastIndexOf(" = $$createComponent(");
  const at = call === -1 ? -1 : code.indexOf(field, call);
  if (call === -1 || at === -1) {
    throw new UnsupportedFileError(
      compilePath,
      "the Astro compiler did not emit its createComponent module-id field",
    );
  }
  return code.slice(0, at) + `, ${compilerString(moduleId)}, undefined);` + code.slice(at + field.length);
}

function compilerString(value: string): string {
  return `'${value
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")}'`;
}
