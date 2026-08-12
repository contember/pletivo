/**
 * The CSS a rendered page carries, inlined in a `<style>` — no linked stylesheet.
 *
 * The Bun host builds one bundle for the whole site and links it from every page.
 * This host used to do the same, and that is what forced every render to compile
 * every module: one sheet needs every route's CSS imports, which needs the whole
 * module graph. `docs/todos/023 §5` takes the decision the other way — the sheet is
 * per page and inline, so nothing here reaches past the page being rendered.
 *
 * Three inputs feed it, in the order they concatenate:
 *
 *   1. every `.css` file under `srcDir`, either compiled by Tailwind (when one of
 *      them does `@import "tailwindcss"`) or concatenated verbatim;
 *   2. the CSS side-effect imports reachable from **the rendering page** through the
 *      JavaScript module graph — `import "./x.css"` in `.astro` frontmatter, and the
 *      same in any module that frontmatter imports;
 *   3. in Tailwind mode only, the source-tree CSS those imports named, verbatim —
 *      the Bun host adds it back because the Tailwind entry is the only source file
 *      the compile pass covered.
 *
 * **1 stays project-wide, and that is deliberate.** It needs a *key* scan of `files`
 * plus the `.css` bytes — no module graph, no compile — so it forces nothing. Narrowing
 * it to the page's graph would break the very common project whose `global.css` is
 * picked up by the Bun host's `**\/*.css` glob and never `import`ed from any module:
 * the page would render unstyled, with no error anywhere. It is also what lets
 * `findTailwindEntry` find an entry nothing imports.
 *
 * 2 and 3 are rooted at the page and ordered by `moduleOrder` — the depth-first
 * post-order the scoped `<style>` blocks already cascade in (`docs/todos/014`), so both
 * halves of a page's CSS finally agree on one ordering rule.
 *
 * ## Tailwind's content is the rendered HTML
 *
 * `compileTailwind` is handed `extractCandidates(html)` rather than a scan of the
 * sources, the way the Tailwind CDN works. Measured on a real project: the source scan
 * is 22 657 candidates / 83.8 kB / 190 ms per render, a rendered page 961–1 275
 * candidates / 39.5–50.1 kB / 19–30 ms.
 *
 * **The known hole:** a class that only appears once client JS runs —
 * `classList.add('hidden')`, a `class:list` branch this render did not take — is not in
 * the HTML, while a source scan finds the string literal. It is theoretical on this
 * host today, and only because this host ships **no client bundles at all**: islands
 * render as inert `<pletivo-island>` markup and no hydration script is emitted
 * (`docs/todos/016 §7`, "What is left"). When islands land, the candidate source
 * becomes the rendered HTML ∪ the client bundles that page ships.
 *
 * The scoped `<style>` blocks are not scanned, and should not be: `finalizeHtml`
 * injects them *after* the render, so they are not in the HTML this reads. That
 * sidesteps `border`, one of the two false candidates `docs/todos/016 §1` records the
 * JS scanner disagreeing with oxide about — it comes from CSS text inside a `<style>`.
 *
 * ## Where this cannot match the Bun host
 *
 * The delivery itself, now: the Bun host links `/assets/styles.<hash>.css` and this one
 * inlines. Permanent, accepted, and recorded in `docs/todos/016 §7` — with the byte
 * comparison that used to ride on it re-proved one level down in `local-parity.ts`.
 *
 * CSS imported from **outside** `srcDir` (a vendor directory, a package) goes through
 * `Bun.build` on the Bun host, which is a full CSS parse and re-print: `rgb(1, 2, 3)`
 * comes out `#010203`, `margin: 0px` comes out `margin: 0`, nesting is flattened. That
 * is a lightningcss-equivalent engine and there is none in an isolate, so this module
 * emits the same *framing* Bun does — `/* <path> *\/` per file — around the file's
 * **original** bytes. Same rules, same cascade; different bytes. Source-tree CSS (1 and
 * 3) is read verbatim on both hosts and does match byte for byte.
 *
 * Also unported, and absent rather than different: `.scss`/`.sass` compilation, CSS
 * modules, and the CSS that hoisted `<script>` bundling contributes.
 */

import { moduleOrder } from "./page-css.ts";
import { compileTailwind, extractCandidates, type TailwindStylesheets } from "./tailwind.ts";

export interface PageStylesheetOptions {
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
  /** The rendering page's project path — the root of the walk. */
  entry: string;
  /** The HTML the page just rendered to, which is what Tailwind's content is. */
  html: string;
  /** Tailwind's own stylesheets, as text. Only needed when a project stylesheet imports it. */
  tailwind?: TailwindStylesheets;
}

/** A page stylesheet is wanted but Tailwind's own sources were not handed over. */
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
 * One page's stylesheet as text, or `null` when the page carries none.
 *
 * `null` is not "empty": the Bun host writes no file and injects no `<link>` when
 * there is neither source CSS nor a collected import, and a page that gained an empty
 * `<style>` here would diverge on every fixture that has no CSS at all.
 */
export async function pageStylesheet(options: PageStylesheetOptions): Promise<string | null> {
  const base = await baseCss(options);
  const collected = collectedCss(options, !base.includesAllSourceCss);

  // Exactly the Bun host's guard, including its asymmetry: an empty-but-present base
  // still produces a stylesheet, a missing one plus no imports produces nothing.
  if (base.css === null && !collected) return null;
  return [base.css, collected].filter(Boolean).join("\n\n");
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

async function baseCss(options: PageStylesheetOptions): Promise<BaseCss> {
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
        candidates: extractCandidates(options.html),
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
function sourceStylesheets(options: {
  files: ReadonlyMap<string, string>;
  srcDir: string;
}): SourceStylesheet[] {
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

/**
 * The project's Tailwind entry, or `null` when nothing imports Tailwind.
 *
 * Exported for `local-parity.ts` alone: with the stylesheet no longer a file, the only
 * way left to compare this host's Tailwind bytes against the Bun host's is to compile
 * the same entry with the same candidates and diff. See `docs/todos/016 §7`.
 */
export function tailwindEntry(options: {
  files: ReadonlyMap<string, string>;
  srcDir: string;
}): string | null {
  return findTailwindEntry(sourceStylesheets(options))?.file ?? null;
}

// ── 2 and 3. What the page's module graph imports ───────────────────

/**
 * The CSS the page's JavaScript graph pulls in: everything outside the source tree,
 * then — in Tailwind mode — the source-tree files it named, verbatim.
 */
function collectedCss(options: PageStylesheetOptions, includeSourceCss: boolean): string {
  const imported = collectCssImports(options.entry, options);
  const parts = [externalBundle(imported.external, options.files)];
  if (includeSourceCss) parts.push(sourceCssOutput(imported.source, options));
  return parts.filter(Boolean).join("\n\n");
}

interface ImportedCss {
  /** Stylesheets under `srcDir`. */
  source: string[];
  /** Stylesheets anywhere else — a vendor directory, a package. */
  external: string[];
}

/**
 * Every stylesheet the page reaches through **JavaScript** imports, in cascade order.
 *
 * `.astro` children are followed, and that matters: while every `.astro` file was its
 * own collection root this walk had to skip them or collect the same CSS twice, but
 * with one root per page a skipped layout takes its `import "../styles/fonts.css"`
 * with it — which on a real site is most of the CSS.
 *
 * `moduleOrder` is what puts them in order, so a stylesheet an inner component imports
 * precedes one the page imports itself, exactly as the scoped `<style>` blocks do.
 */
export function collectCssImports(entry: string, options: PageStylesheetOptions): ImportedCss {
  const prefix = withSlash(options.srcDir);
  const source: string[] = [];
  const external: string[] = [];
  const seen = new Set<string>();

  for (const file of moduleOrder(entry, options.imports)) {
    for (const css of options.cssImports.get(file) ?? []) {
      if (seen.has(css)) continue;
      seen.add(css);
      (css.startsWith(prefix) ? source : external).push(css);
    }
  }
  return { source, external };
}

/**
 * The out-of-tree stylesheets, framed the way `Bun.build` frames a CSS bundle: a
 * `/* <path> *\/` line per file, blocks separated by a blank line. The bytes between
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
 * The source-tree stylesheets the graph named, labelled relative to the project root —
 * `readSourceCssOutput` on the Bun host.
 */
function sourceCssOutput(
  css: readonly string[],
  options: { files: ReadonlyMap<string, string>; rootDir: string },
): string {
  const prefix = withSlash(options.rootDir);
  const parts: string[] = [];
  for (const file of css) {
    const content = options.files.get(file);
    if (content === undefined) continue;
    const label = file.startsWith(prefix) ? file.slice(prefix.length) : file;
    parts.push(`/* ${label} */\n${content}`);
  }
  return parts.join("\n\n");
}

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
