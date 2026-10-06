import type { AstroCompiler } from "../astro-compiler.ts";
import type { ProjectAssetsView } from "../asset-port.ts";
import type { CompileCache } from "../compile-cache.ts";
import type { ExecutableProgram, ResolvedStyleGraph } from "../compiled-program.ts";
import type { ProjectArtifact } from "../project-artifact.ts";
import type { ProjectFiles } from "../project-store.ts";
import type { TailwindStylesheets } from "../tailwind.ts";

/** One `<style>` block from a `.astro` file, in the order it was written. */
export interface StyleBlock {
  /** `<style is:global>`. Gated on the component rendering, not on its scope class. */
  global: boolean;
  css: string;
}

export interface AstroStyles {
  /** The compiler's scope hash — the page carries it as `class="astro-{scope}"`. */
  scope: string;
  blocks: StyleBlock[];
}

export interface CompiledProject {
  /** What the isolate executes: the module map, the entries and the features to install. */
  program: ExecutableProgram;
  /** The CSS inputs, retaining source-order edges by logical ModuleId. */
  styleGraph: ResolvedStyleGraph;
  /**
   * The caller's files plus the artifact's sources. Downstream graph walkers (the CSS
   * pipeline) must read these, or a `node_modules` component's edges lead nowhere.
   */
  sources: ProjectFiles;
  /** Files a `?url` import named, keyed by the URL path the HTML spells; the host must serve them. */
  urlAssets: ReadonlyMap<string, string>;
}

export interface CompileProjectOptions {
  /** The project: path (no leading slash, `/` separators) -> source text. */
  files: ProjectFiles;
  /**
   * The pages the bundle has to serve. Only what their import graphs reach is
   * compiled. Absent, every module-shaped file in the map is compiled.
   */
  entries?: readonly string[];
  /** Overrides the compiler bound to the bundled `astro.wasm` — see `bundled`. */
  compiler?: AstroCompiler;
  /** Where the source tree starts in `files`, e.g. `src`. Used to probe for the content config. */
  srcDir?: string;
  /** What `pletivo prepare` froze: resolutions for bare specifiers and their `node_modules` sources. */
  artifact?: ProjectArtifact;
  /** Tailwind's host-embedded CSS sources, used only for CSS imports of its public stylesheets. */
  tailwind?: TailwindStylesheets;
  /** The project's binary files. Only an imported image is read, and becomes a metadata module. */
  assets?: ProjectAssetsView;
  /** Compiled files kept between calls, keyed by path and checked by `source ===`. */
  cache?: CompileCache;
}
