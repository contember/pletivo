import type { ModuleId } from "@pletivo/core/artifact";
import { cssImports, tailwindModuleRefs } from "@pletivo/core/css-imports";
import type { CompiledFile } from "../compile-cache.ts";
import { HOST_ALIASES } from "../host-aliases.ts";
import { rewriteImports } from "../rewrite-imports.ts";
import { expandImportMetaGlobs } from "./import-meta-glob.ts";
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
  if (entry.importMetaEnv) walk.usesImportMetaEnv = true;
  if (entry.styles !== null) walk.styles.set(module.id, entry.styles);
  entry.scripts.forEach((code, index) => {
    if (code !== null) walk.scripts.push({ moduleId: module.id, compilePath: module.compilePath, index, code });
  });
  const written = entry.code ?? entry.source;
  const globbed = entry.globs.length === 0
    ? { code: written, specifiers: [] }
    : expandImportMetaGlobs(written, entry.globs, module.compilePath, [...walk.projectPaths(), ...resolver.assetSources()]);
  const bySpecifier = new Map<string, ResolutionUse>();
  for (const specifier of [...entry.specifiers, ...globbed.specifiers]) {
    let use = bySpecifier.get(specifier);
    if (use === undefined) {
      use = await resolver.resolve(module, specifier);
      bySpecifier.set(specifier, use);
      if (use.kind === "module") walk.addEdge(module, use.module);
    }
    if (use.kind === "external" && HOST_ALIASES.get(use.specifier)?.kind === "env") {
      walk.useEnv(use.specifier, entry.envNames?.get(specifier) ?? []);
    }
  }
  const compiledCode = module.kind === "astro"
    ? replaceComponentPaths(replaceAstroTrackingId(globbed.code, module.compilePath, module.id), walk, module)
    : module.kind === "mdx"
      ? replaceMdxComponentPaths(globbed.code, entry.componentPaths, walk, module)
      : globbed.code;
  walk.modules[module.executionName] = rewriteImports(compiledCode, {
    importer: module.compilePath,
    resolve(_resolved, specifier) {
      const use = bySpecifier.get(specifier);
      if (use === undefined) {
        throw unresolvedImport(module, specifier, "rewrite-mismatch", "rewrite did not see the canonical resolution");
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
  for (const specifier of cssImports(module.source)) {
    const use = await resolver.resolve(module, specifier);
    if (use.kind !== "module" || use.module.kind !== "css") {
      throw unresolvedImport(module, specifier, "css-import-not-css", "CSS @import must resolve to a CSS module");
    }
    walk.addEdge(module, use.module);
  }
  for (const ref of tailwindModuleRefs(module.source)) {
    walk.tailwindModules.push({ stylesheet: module.id, specifier: ref.specifier, module: resolver.resolveTailwindModule(module, ref) });
  }
  walk.modules[module.executionName] = "export {};\n";
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

/** The compiler's `client:component-path` prop: `resolvePath` cannot cross to a compiler isolate, so every value is the specifier. */
const COMPONENT_PATH = /"client:component-path":\(("(?:[^"\\\n]|\\.)*")\)/g;

/** Each `client:component-path` as Bun's compiler resolves it, which the island `uid` hashes. */
function replaceComponentPaths(code: string, walk: CompileWalk, module: SourceModule): string {
  if (module.origin !== "project") return code;
  return code.replace(COMPONENT_PATH, (_found, literal: string) => {
    let specifier: unknown;
    try {
      specifier = JSON.parse(literal);
    } catch {
      specifier = undefined;
    }
    if (typeof specifier !== "string") {
      throw new UnsupportedFileError(module.compilePath, `the Astro compiler wrote a client:component-path pletivo cannot read: ${literal}`);
    }
    return `"client:component-path":(${JSON.stringify(walk.componentPath(module.compilePath, specifier))})`;
  });
}

/** `@mdx-js/mdx` writes a JSX attribute as a property with a JSON string value. */
function mdxComponentPathProp(path: string): string {
  return `"client:component-path": ${JSON.stringify(path)}`;
}

/** An `.mdx` module's `client:component-path` values, rebuilt as for `.astro` (`replaceComponentPaths`). */
function replaceMdxComponentPaths(code: string, written: readonly string[], walk: CompileWalk, module: SourceModule): string {
  let out = code;
  for (const specifier of new Set(written)) {
    const prop = mdxComponentPathProp(specifier);
    if (!out.includes(prop)) {
      throw new UnsupportedFileError(module.compilePath, `the MDX compile wrote no ${prop}; the @mdx-js/mdx output contract may have changed`);
    }
    out = out.replaceAll(prop, mdxComponentPathProp(walk.componentPath(module.compilePath, specifier)));
  }
  return out;
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
