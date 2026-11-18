/**
 * What `prepare` reads off the project's `.mdx` files. Each compiles here as `pletivo build`
 * compiles it, so its imports join the vendor graph and its hydrations get island clients.
 */

import type { ArtifactMdxConfig } from "@pletivo/core/artifact";
import type { CompiledMdx } from "@pletivo/core/content/mdx";
import type { AstroConfig } from "@pletivo/core/astro-host/types";
import type { PletivoConfig } from "../config";
import { mdxSourceFacts, resolveMdxOptions, type MdxOptions } from "../mdx-plugin";
import { PrepareError, prepareFailure } from "./error";
import type { AstroHydrations } from "./islands";
import { freezeMdx } from "./markdown";
import { extensionOf } from "./scan";
import type { ProjectImportSource } from "./vendor";

/** A project `.mdx` file outside `srcDir`, which a page may import. */
export interface OutsideMdxFile {
  file: string;
  source: string;
}

export interface PreparedMdx {
  /** `null` when the project has no `.mdx` file. */
  config: ArtifactMdxConfig | null;
  /** The sources, each `.mdx` one with its compiled code and hydrations. */
  sources: ProjectImportSource[];
  /** What the `.mdx` files outside `srcDir` hydrate. */
  outsideHydrations: AstroHydrations[];
}

export async function prepareMdx(
  pletivoConfig: PletivoConfig,
  astroConfig: AstroConfig | undefined,
  sources: readonly ProjectImportSource[],
  outside: readonly OutsideMdxFile[],
): Promise<PreparedMdx> {
  if (!sources.some(isMdx) && outside.length === 0) return { config: null, sources: [...sources], outsideHydrations: [] };
  let options: MdxOptions;
  try {
    options = resolveMdxOptions(pletivoConfig, astroConfig);
  } catch (error) {
    throw prepareFailure("astro.config", "mdx", error instanceof Error ? error.message : String(error));
  }
  const frozen = freezeMdx(options, pletivoConfig, astroConfig);
  if (frozen.diagnostics.length > 0) throw new PrepareError(frozen.diagnostics);
  const compiled = await Promise.all(
    sources.map(async (source): Promise<ProjectImportSource> => {
      if (!isMdx(source)) return source;
      let facts: CompiledMdx;
      try {
        facts = await mdxSourceFacts(source.source, source.file, options);
      } catch (error) {
        throw prepareFailure(source.file, "scan", error instanceof Error ? error.message : String(error));
      }
      const hydrated = facts.hydrated.map(({ componentPath, exportName }) => ({ componentPath, exportName }));
      return { ...source, compiled: facts.code, ...(hydrated.length > 0 ? { hydrated } : {}) };
    }),
  );
  const outsideHydrations: AstroHydrations[] = [];
  for (const { file, source } of outside) {
    let facts: CompiledMdx;
    try {
      facts = await mdxSourceFacts(source, file, options);
    } catch {
      // Not necessarily reached by any page; one that is fails its render on either host with this error.
      continue;
    }
    const hydrated = facts.hydrated.map(({ componentPath, exportName }) => ({ componentPath, exportName }));
    if (hydrated.length > 0) outsideHydrations.push({ file, hydrated });
  }
  return { config: frozen.config, sources: compiled, outsideHydrations };
}

function isMdx(source: ProjectImportSource): boolean {
  return extensionOf(source.file) === ".mdx";
}
