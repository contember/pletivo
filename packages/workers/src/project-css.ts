/**
 * The project-wide stylesheet: `<link rel="stylesheet" href="/assets/styles.<hash>.css">`.
 *
 * A port of the Bun host's `css.ts` + `js-imported-css.ts`. Both hosts emit **one**
 * stylesheet for the whole site, not one per page, so this walks the whole project's
 * module graph rather than the rendering page's — the same file is linked from every
 * page and its hash has to be stable across them.
 *
 * Three inputs feed it, in the order they concatenate:
 *
 *   1. every `.css` file under `srcDir`, either compiled by Tailwind (when one of
 *      them does `@import "tailwindcss"`) or concatenated verbatim;
 *   2. the CSS side-effect imports reachable from each collection root through the
 *      **JavaScript** module graph — `import "./x.css"` in `.astro` frontmatter, and
 *      the same in any `.ts`/`.js` module that frontmatter imports;
 *   3. in Tailwind mode only, the source-tree CSS those imports named, verbatim —
 *      the Bun host adds it back because the Tailwind entry is the only source file
 *      the compile pass covered.
 *
 * The filename is `md5(bundle).slice(0, 8)`, which is what makes the `<link>` line
 * byte-comparable at all: a single byte anywhere in the bundle moves it.
 *
 * ## Where this cannot match the Bun host
 *
 * CSS imported from **outside** `srcDir` (a vendor directory, a package) goes through
 * `Bun.build` on the Bun host, which is a full CSS parse and re-print: `rgb(1, 2, 3)`
 * comes out `#010203`, `margin: 0px` comes out `margin: 0`, nesting is flattened. That
 * is a lightningcss-equivalent engine and there is none in an isolate, so this module
 * emits the same *framing* Bun does — `/* <path> *\/` per file, in the same order —
 * around the file's **original** bytes. Same rules, same cascade; different bytes, and
 * therefore a different hash. Source-tree CSS (1 and 3) is read verbatim on both hosts
 * and does match byte for byte.
 *
 * Also unported, and absent rather than different: `.scss`/`.sass` compilation, CSS
 * modules, and the CSS that hoisted `<script>` bundling contributes.
 */

import { md5Hex } from "./md5.ts";
import { compileTailwind, type TailwindStylesheets } from "./tailwind.ts";

/** A module whose CSS imports are collected, and the key the output is ordered by. */
export interface CssRoot {
  /**
   * The Bun host's map key for this module: `astro:<path>` from the loader plugin,
   * `page:<route file>` from the page-module pass. Only the sort order it produces
   * is observable.
   */
  key: string;
  /** Project path of the module the walk starts at. */
  file: string;
}

export interface ProjectCssOptions {
  /** The project: path (no leading slash, `/` separators) -> source text. */
  files: ReadonlyMap<string, string>;
  /** Where the source tree starts in `files`, e.g. `src`. `""` when it is the root. */
  srcDir: string;
  /** Where the project root starts in `files`. `""` when `files` is rooted there. */
  rootDir: string;
  /** Project path -> the `.css` files it imports. From `compileProject`. */
  cssImports: ReadonlyMap<string, string[]>;
  /** Project path -> the modules it imports. From `compileProject`. */
  imports: ReadonlyMap<string, string[]>;
  /** The modules to collect from. See `cssRoots`. */
  roots: readonly CssRoot[];
  /** Tailwind's own stylesheets, as text. Only needed when a project stylesheet imports it. */
  tailwind?: TailwindStylesheets;
}

export interface ProjectStylesheet {
  /** The `href` the page's `<link>` carries, and the path the host must serve. */
  href: string;
  css: string;
}

/** A project stylesheet is wanted but Tailwind's own sources were not handed over. */
export class TailwindNotConfiguredError extends Error {
  constructor(readonly entry: string) {
    super(
      `[pletivo-workers] ${JSON.stringify(entry)} imports Tailwind, but renderPage() was ` +
        "given no `tailwind` stylesheets. The isolate cannot read them off disk — the host " +
        "worker's bundler has to embed tailwindcss/index.css, preflight.css, theme.css and " +
        "utilities.css and pass them in.",
    );
    this.name = "TailwindNotConfiguredError";
  }
}

/** Extension the two hosts agree is a stylesheet. `.scss`/`.sass` are not ported. */
const CSS = ".css";
/** Handled by the CSS-modules pipeline on the Bun host, which is not ported either. */
const CSS_MODULE = ".module.css";

/**
 * Whether a project path is a stylesheet this pipeline collects.
 *
 * Mirrors the Bun host's `isCssSpecifier` for the cases an isolate can see: a `.css`
 * file that is not a CSS module. Bare specifiers that resolve into `node_modules`
 * cannot be resolved here at all, so they never reach this.
 */
export function isCollectableCss(file: string): boolean {
  return file.endsWith(CSS) && !file.endsWith(CSS_MODULE);
}

/**
 * The whole project's stylesheet, or `null` when the project has none.
 *
 * `null` is not "empty": the Bun host writes no file and injects no `<link>` when
 * there is neither source CSS nor a collected import, and a page that gained an empty
 * `<link>` here would diverge on every fixture that has no CSS at all.
 */
export async function projectStylesheet(
  options: ProjectCssOptions,
): Promise<ProjectStylesheet | null> {
  const base = await baseCss(options);
  const collected = collectedCss(options, !base.includesAllSourceCss);

  // Exactly the Bun host's guard, including its asymmetry: an empty-but-present base
  // still produces a stylesheet, a missing one plus no imports produces nothing.
  if (base.css === null && !collected) return null;
  const css = [base.css, collected].filter(Boolean).join("\n\n");

  return { href: `/assets/styles.${md5Hex(css).slice(0, 8)}.css`, css };
}

// ── 1. The source tree ──────────────────────────────────────────────

interface BaseCss {
  css: string | null;
  /**
   * Whether the source tree is already fully represented. False in Tailwind mode,
   * where only the entry stylesheet's `@import` graph was compiled — which is what
   * makes the Bun host append the imported source CSS again, verbatim.
   */
  includesAllSourceCss: boolean;
}

async function baseCss(options: ProjectCssOptions): Promise<BaseCss> {
  const sources = sourceStylesheets(options);
  if (sources.length === 0) return { css: null, includesAllSourceCss: true };

  const entry = findTailwindEntry(sources);
  if (entry) {
    if (!options.tailwind) throw new TailwindNotConfiguredError(entry.file);
    return {
      css: await compileTailwind({
        entry: entry.file,
        files: options.files,
        stylesheets: options.tailwind,
      }),
      includesAllSourceCss: false,
    };
  }

  const parts = [...sources]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((source) => `/* ${source.name} */\n${source.content}`);
  return { css: parts.join("\n\n"), includesAllSourceCss: true };
}

interface SourceStylesheet {
  /** Project path. */
  file: string;
  /** Path relative to `srcDir` — the label the Bun host writes into the bundle. */
  name: string;
  content: string;
}

/** Every stylesheet under `srcDir`, the way the Bun host's `**\/*.css` glob sees them. */
function sourceStylesheets(options: ProjectCssOptions): SourceStylesheet[] {
  const prefix = withSlash(options.srcDir);
  const sources: SourceStylesheet[] = [];
  for (const [file, content] of options.files) {
    if (!file.startsWith(prefix) || !isCollectableCss(file)) continue;
    sources.push({ file, name: file.slice(prefix.length), content });
  }
  return sources;
}

/** Filenames the Bun host looks at first when hunting for the Tailwind entry. */
const PREFERRED_ENTRIES = ["global.css", "app.css", "main.css", "styles.css"];
const IMPORTS_TAILWIND = /@import\s+["']tailwindcss["']/;

/**
 * The stylesheet that pulls Tailwind in, searched in the Bun host's order.
 *
 * The order is observable: two files could both `@import "tailwindcss"`, and only the
 * first becomes the compile entry — the other is then just a file in the source tree.
 */
function findTailwindEntry(sources: readonly SourceStylesheet[]): SourceStylesheet | null {
  const ranked = [...sources].sort((a, b) => {
    const ai = PREFERRED_ENTRIES.indexOf(basename(a.name));
    const bi = PREFERRED_ENTRIES.indexOf(basename(b.name));
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.name.localeCompare(b.name);
  });
  return ranked.find((source) => IMPORTS_TAILWIND.test(source.content)) ?? null;
}

// ── 2 and 3. What the module graph imports ──────────────────────────

/**
 * The CSS the JavaScript graph pulls in: per-root bundles of everything outside the
 * source tree, then — in Tailwind mode — the source-tree files, once, verbatim.
 */
function collectedCss(options: ProjectCssOptions, includeSourceCss: boolean): string {
  const external = new Map<string, string>();
  const fromSource = new Set<string>();

  for (const root of options.roots) {
    const imported = collectCssImports(root.file, options);
    for (const file of imported.source) fromSource.add(file);
    if (imported.external.length > 0) {
      external.set(root.key, externalBundle(imported.external, options.files));
    }
  }

  // Sorted by key, not by insertion: the Bun host collects during parallel page
  // imports, so insertion order there is not a property of the project.
  const parts = [...external.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, css]) => css);
  if (includeSourceCss) parts.push(sourceCssOutput(fromSource, options));
  return parts.filter(Boolean).join("\n\n");
}

interface ImportedCss {
  /** Stylesheets under `srcDir`. */
  source: string[];
  /** Stylesheets anywhere else — a vendor directory, a package. */
  external: string[];
}

/**
 * Every stylesheet reachable from one module through **JavaScript** imports.
 *
 * `.astro` children are not followed, and that is the Bun host's shape, not an
 * omission: its `resolveLocalModule` only resolves `.ts`/`.tsx`/`.js`/`.jsx`/`.mjs`/
 * `.cjs`, and every `.astro` file is a collection root of its own, so following them
 * here would collect the same CSS twice under two keys.
 *
 * Both lists come out sorted, so the order the walk happens to take is not observable
 * — which is also why the two edge maps can be read separately.
 */
export function collectCssImports(root: string, options: ProjectCssOptions): ImportedCss {
  const prefix = withSlash(options.srcDir);
  const source = new Set<string>();
  const external = new Set<string>();
  const visited = new Set<string>([root]);

  const visit = (file: string): void => {
    for (const css of options.cssImports.get(file) ?? []) {
      (css.startsWith(prefix) ? source : external).add(css);
    }
    for (const child of options.imports.get(file) ?? []) {
      if (child.endsWith(".astro") || visited.has(child)) continue;
      visited.add(child);
      visit(child);
    }
  };
  visit(root);

  return { source: [...source].sort(), external: [...external].sort() };
}

/**
 * One root's out-of-tree stylesheets, framed the way `Bun.build` frames a CSS bundle:
 * a `/* <path> *\/` line per file, blocks separated by a blank line. The bytes between
 * the comments are the file's own, where Bun's would be re-printed — see the header.
 */
function externalBundle(css: readonly string[], files: ReadonlyMap<string, string>): string {
  const parts: string[] = [];
  for (const file of css) {
    const content = files.get(file);
    if (content === undefined) continue;
    parts.push(`/* ${file} */\n${content}`);
  }
  return parts.join("\n");
}

/**
 * The source-tree stylesheets the graph named, deduped across roots and labelled
 * relative to the project root — `readSourceCssOutput` on the Bun host.
 */
function sourceCssOutput(files: ReadonlySet<string>, options: ProjectCssOptions): string {
  const prefix = withSlash(options.rootDir);
  const parts: string[] = [];
  for (const file of [...files].sort()) {
    const content = options.files.get(file);
    if (content === undefined) continue;
    const label = file.startsWith(prefix) ? file.slice(prefix.length) : file;
    parts.push(`/* ${label} */\n${content}`);
  }
  return parts.join("\n\n");
}

// ── Roots ───────────────────────────────────────────────────────────

/**
 * The modules the Bun host collects CSS imports from, for the whole project.
 *
 * Two passes there, reproduced here from one graph: the loader plugin fires for every
 * `.astro` file the build loads (`astro:<path>`), and the page loop collects from every
 * page module that is not `.astro` and not `.md` (`page:<route file>`). "Every `.astro`
 * file the build loads" is the set reachable from a page — an orphaned component is
 * never imported, so its CSS never lands in the bundle.
 */
export function cssRoots(options: {
  /** Project path -> the route file it was matched as, for every page in the project. */
  pages: ReadonlyMap<string, string>;
  /** Project path -> the modules it imports. From `compileProject`. */
  imports: ReadonlyMap<string, string[]>;
}): CssRoot[] {
  const roots = new Map<string, CssRoot>();
  const seen = new Set<string>();

  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    if (file.endsWith(".astro")) roots.set(`astro:${file}`, { key: `astro:${file}`, file });
    for (const child of options.imports.get(file) ?? []) visit(child);
  };

  for (const [file, routeFile] of options.pages) {
    visit(file);
    if (COLLECTED_PAGE_EXTENSIONS.some((extension) => file.endsWith(extension))) {
      roots.set(`page:${routeFile}`, { key: `page:${routeFile}`, file });
    }
  }

  return [...roots.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * Page kinds the Bun host reads CSS imports out of directly.
 *
 * `.astro` is already covered by the loader plugin and `.md` has no imports, which is
 * why neither is here — the same two exclusions `collectPageModuleCss` makes.
 */
const COLLECTED_PAGE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mdx"];

// ── Paths ───────────────────────────────────────────────────────────

/** A directory prefix that a child path starts with. `""` stays `""`, matching the root. */
function withSlash(dir: string): string {
  return dir === "" ? "" : `${dir}/`;
}

function basename(file: string): string {
  const at = file.lastIndexOf("/");
  return at === -1 ? file : file.slice(at + 1);
}

/** The parent of a virtual path, `""` at the root. */
export function parentDir(dir: string): string {
  const at = dir.lastIndexOf("/");
  return at === -1 ? "" : dir.slice(0, at);
}
