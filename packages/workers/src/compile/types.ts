import type { AstroCompiler } from "../astro-compiler.ts";
import type { ProjectAssetsView } from "../asset-port.ts";
import type { CompileCache } from "../compile-cache.ts";
import type { ExecutableProgram, ResolvedStyleGraph } from "../compiled-program.ts";
import type { ProjectEnvUse } from "../env.ts";
import type { ResolvedModuleGraph } from "../module-graph.ts";
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
  /** Module name -> JavaScript, ready for `env.LOADER`. Includes `@pletivo/runtime`. */
  modules: Record<string, string>;
  /**
   * The files this was compiled from: the caller's, plus whatever the artifact
   * contributed, composed per lookup rather than copied. Everything downstream that
   * walks the graph — the CSS pipeline above all — has to see the same files, or a
   * `node_modules` component's edges lead nowhere.
   */
  sources: ProjectFiles;
  /** Project path -> its module name, for the files that produced one. */
  moduleNames: ReadonlyMap<string, string>;
  /**
   * The pages the bundle was built for: `options.entries`, or every module-shaped
   * file when the caller named none.
   *
   * `render.ts` builds the isolate's page table from this rather than from
   * `moduleNames`, which also holds the components and libraries those pages import —
   * modules the page loader is never called with.
   */
  entries: readonly string[];
  /** Project path -> the `<style>` blocks it declares. */
  styles: ReadonlyMap<string, AstroStyles>;
  /** Project path -> the project paths it imports, in execution order. */
  imports: ReadonlyMap<string, string[]>;
  /**
   * Project path -> the stylesheets it imports for their side effect.
   *
   * Kept apart from `imports` because they are not edges the isolate walks — a `.css`
   * module is empty in the bundle. They are what the project stylesheet is built from;
   * see `project-css.ts`.
   */
  cssImports: ReadonlyMap<string, string[]>;
  /**
   * Set when something in the project imports the content API, which is what puts
   * `pletivo-content.js` in the bundle. `null` otherwise, and then the bundle carries
   * none of it — the collection runtime is roughly a megabyte, and most projects have
   * no collections.
   */
  content: ProjectContent | null;
  /**
   * Whether the bundle carries the image runtime — because a page imports
   * `astro:assets`, or because a collection may resolve an `image()` schema through
   * the content binding. `render.ts` reads it to decide what its prelude installs.
   */
  images: boolean;
  /**
   * Whether any module read `import.meta.env`, and therefore whether the entry has to
   * install the global it was rewritten to. See `substituteImportMetaEnv`.
   */
  importMetaEnv: boolean;
  /**
   * Set when something in the project imports `astro:env`, with the names it takes
   * from each half. `null` otherwise, and then the bundle carries neither module.
   *
   * The values themselves are not here and never enter the module map: they ride in
   * the isolate's `env`, so rotating a secret does not recompile the project. See
   * `env.ts`.
   */
  env: ProjectEnvUse | null;
  /**
   * Files a `?url` import named, keyed by the URL path the HTML will spell.
   *
   * `import href from "./form.js?url"` resolves to a *string*, and the file it names
   * has to be served from that string or the `<script src={href}>` written with it
   * 404s. The Bun host content-hashes it under `_astro/` (`url-asset.ts`) and copies
   * it into `dist`; here it comes back with the render, the same way the project
   * stylesheet does, because a Worker has nowhere to put a file.
   */
  urlAssets: ReadonlyMap<string, string>;
  /** Frozen compiler/execution seam, derived from the same canonical resolution pass. */
  program: ExecutableProgram;
  /** Frozen CSS seam, retaining source-order edges by logical ModuleId. */
  styleGraph: ResolvedStyleGraph;
  /** The canonical graph behind both legacy maps and the frozen DTOs. */
  graph: ResolvedModuleGraph;
}

export interface ProjectContent {
  /**
   * Bundle name of the project's `content.config.*`, or `null` when it has none.
   * The isolate imports it to get the collection definitions — there is no other way
   * to obtain them, since `defineCollection` is a function call, not data.
   */
  configModule: string | null;
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
  /**
   * Where the source tree starts in `files`, e.g. `src`.
   *
   * Only the content config needs it, and only to be probed for rather than scanned
   * after: nothing in a project imports it, so a pruned walk has to seed it by path.
   */
  srcDir?: string;
  /**
   * What `pletivo prepare` froze: it answers the bare specifiers the file map cannot,
   * and contributes the `node_modules` sources those specifiers land on. Without one,
   * a bare specifier is left alone and the Loader reports it.
   */
  artifact?: ProjectArtifact;
  /** Tailwind's host-embedded CSS sources, used only for CSS imports of its public stylesheets. */
  tailwind?: TailwindStylesheets;
  /**
   * The project's binary files. An image *something imports* becomes a metadata
   * module, so `import hero from "./hero.png"` resolves to the same `{src, width,
   * height, format}` the Bun host's loader produces — built here, in the host worker,
   * because an ESM default export is a value and the isolate cannot go and fetch one.
   *
   * Only what is imported, not everything in the map: a photo site can hold thousands
   * of images and a page reaches a handful. The rest are named by the collections that
   * carry them, over the binding, one entry at a time.
   */
  assets?: ProjectAssetsView;
  /**
   * Compiled files kept between calls, keyed by path and checked by `source ===`.
   * Absent, every file is compiled. See `compile-cache.ts` for what an entry carries
   * and why the rest is reproduced on a hit rather than stored.
   */
  cache?: CompileCache;
}
