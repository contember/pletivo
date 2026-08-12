/**
 * The consuming half of a prepared site artifact.
 *
 * `pletivo prepare` ran the config/integration phase on Bun, where a filesystem and
 * npm exist, and froze what it produced (`@pletivo/core/artifact`). Here that frozen
 * thing is turned back into the only two shapes the isolate understands: extra
 * sources to compile, and extra modules to put in the bundle.
 *
 * Both are *code*, so both belong in the module map and both legitimately change
 * `bundleHash` — a different integration set is a different bundle. Nothing per
 * request and nothing per configuration goes here; that rides in `env` or in the
 * request body, and `render.ts` keeps the two apart.
 *
 * Only the modules a project actually reaches are added. A vendored `marked` sits in
 * the artifact whether or not this project imports it, and a bundle that carried it
 * anyway would be both larger and a different content address than the same project
 * prepared without it.
 */

import {
  assertArtifactVersion,
  type ArtifactModules,
  type PreparedSite,
} from "@pletivo/core/artifact";
import { collectSpecifiers } from "./rewrite-imports.ts";

/**
 * A specifier the artifact claims to answer, whose target names nothing.
 *
 * Loud, because the alternative is an unresolved import inside the isolate, which
 * surfaces as "the bundle would not run" with no mention of the artifact at all.
 */
export class ArtifactTargetError extends Error {
  constructor(
    readonly specifier: string,
    readonly target: string,
  ) {
    super(
      `[pletivo-workers] the site artifact maps ${JSON.stringify(specifier)} to ` +
        `${JSON.stringify(target)}, which is neither a generated source nor a module it ` +
        "carries. Re-run `pletivo prepare`.",
    );
    this.name = "ArtifactTargetError";
  }
}

/** What one compile pass takes from an artifact. */
export interface ArtifactBinder {
  /** The file map the project is compiled from: generated sources under the caller's. */
  sources(files: ReadonlyMap<string, string>): ReadonlyMap<string, string>;
  /**
   * The bundle name a resolved specifier lands on, or `null` when the artifact does
   * not answer it. `moduleNames` is consulted first for the artifact's own targets,
   * so a generated source resolves exactly like a project file.
   */
  resolve(resolved: string, moduleNames: ReadonlyMap<string, string>): string | null;
  /** Every artifact module `resolve` reached, plus everything those import. */
  modules(): Record<string, string>;
}

/** A binder for a project with no artifact: answers nothing, adds nothing. */
const EMPTY: ArtifactBinder = {
  sources: (files) => files,
  resolve: () => null,
  modules: () => ({}),
};

/**
 * Bind an artifact to one compile pass.
 *
 * Stateful on purpose — `modules()` reports what `resolve()` reached — and therefore
 * made fresh per `compileProject` call, so no two projects can see each other's set.
 */
export function artifactBinder(prepared: PreparedSite | null | undefined): ArtifactBinder {
  if (!prepared) return EMPTY;
  assertArtifactVersion(prepared.artifact);

  const { virtualModules, vendor, generatedSources } = prepared.artifact;
  const available: ArtifactModules = prepared.modules;
  const used = new Set<string>();

  return {
    sources(files) {
      const entries = Object.entries(generatedSources);
      if (entries.length === 0) return files;
      // Generated sources first, so a project file of the same name wins. There is no
      // legitimate overlap — these are `node_modules` paths — and a project that does
      // overlap should see its own file.
      return new Map([...entries, ...files]);
    },

    resolve(resolved, moduleNames) {
      const target = vendor[resolved] ?? virtualModules[resolved];
      if (target === undefined) return null;
      const name = moduleNames.get(target);
      if (name !== undefined) return `./${name}`;
      if (!(target in available)) throw new ArtifactTargetError(resolved, target);
      used.add(target);
      return `./${target}`;
    },

    modules() {
      const out: Record<string, string> = {};
      const queue = [...used];
      while (queue.length > 0) {
        const name = queue.shift();
        if (name === undefined || name in out) continue;
        const code = available[name];
        if (code === undefined) continue;
        out[name] = code;
        // An artifact module may name another by its bundle name; a package bundled
        // whole names none, so this walk usually stops at the first step.
        for (const specifier of collectSpecifiers(code)) {
          const target = specifier.startsWith("./") ? specifier.slice(2) : specifier;
          if (target in available) queue.push(target);
        }
      }
      return out;
    },
  };
}

/**
 * Module names the artifact supplies, for a diagnostic that must not blame them.
 *
 * A bundled npm package is a megabyte of somebody else's JavaScript, and somewhere in
 * it a line begins `type … =` inside a string. `typescriptSuspects` would name it as
 * the reason an isolate refused to start, which is the exact mistake `1101194` was
 * about — these modules are Bun's own output and cannot carry TypeScript.
 */
export function artifactModuleNames(prepared: PreparedSite | null | undefined): Set<string> {
  return new Set(prepared ? Object.keys(prepared.modules) : []);
}
