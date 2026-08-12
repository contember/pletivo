/**
 * Render one route of a virtual project to HTML, inside a Cloudflare Worker.
 *
 * The whole point of the package: sources live in memory (a Durable Object, a
 * SQLite row, an agent's scratch buffer) and a Worker turns them into a page, with
 * no sandbox and no filesystem anywhere in the path.
 *
 * Two rendering paths, because they need different things:
 *
 *   - `.md` is a pure string transform, so it runs right here in the host worker
 *     through `@pletivo/core`, exactly as the Bun host's `renderMarkdownFile` does.
 *   - `.astro` and `.tsx` compile to JavaScript that has to *execute*, and workerd
 *     has no `eval` or `new Function`. The only door is the Worker Loader binding,
 *     which takes a module map and runs it in its own isolate. `compileProject` fills
 *     that map; this module generates the entry that drives it and stitches the result
 *     back together — doctype, page CSS — the way `build.ts` does on the Bun host.
 *
 * Nothing about a page's own render is host-specific, so the isolate only reports
 * two things back: the HTML, and which component modules ran. The CSS ordering that
 * needs the import graph stays out here, where the graph is.
 */

import { findRoute, parseRoute, type Route, type RouteParams } from "@pletivo/core/router";
import { parseMarkdown } from "@pletivo/core/content/markdown";
import type { AstroCompiler } from "./astro-compiler.ts";
import { compileProject, isExecutableModule, type CompiledProject } from "./compile-project.ts";
import { finalizeHtml, pageCss } from "./page-css.ts";
import { RUNTIME_MODULE_NAME } from "./generated/runtime-modules.ts";

// ── The Worker Loader binding ───────────────────────────────────────
//
// Declared structurally rather than imported from `@cloudflare/workers-types`, so
// the package keeps working whichever typings the host app has installed.

/** What a dynamic Worker is: modules, and which one to start at. */
export interface DynamicWorkerCode {
  compatibilityDate: string;
  compatibilityFlags?: string[];
  mainModule: string;
  modules: Record<string, string>;
  /** `null` cuts the isolate off from the network. Rendering never needs it. */
  globalOutbound?: null;
}

export interface DynamicWorkerStub {
  getEntrypoint(): { fetch(request: Request): Promise<Response> };
}

export interface WorkerLoaderBinding {
  get(id: string, code: () => DynamicWorkerCode | Promise<DynamicWorkerCode>): DynamicWorkerStub;
}

// ── Options and results ─────────────────────────────────────────────

export interface RenderPageOptions {
  /** The project: path (no leading slash, `/` separators) -> source text. */
  files: ReadonlyMap<string, string>;
  /** URL pathname to render, e.g. `/` or `/blog/hello`. */
  pathname: string;
  loader: WorkerLoaderBinding;
  /** Where pages live in `files`. */
  pagesDir?: string;
  /** `site` from the project config. Sets the origin of `Astro.url`. */
  site?: string;
  /** `compatibility_date` for the render isolate. */
  compatibilityDate?: string;
  /**
   * Overrides the compiler bound to the bundled `astro.wasm`. Only a test outside
   * a Worker needs this — see `compileProject`.
   */
  compiler?: AstroCompiler;
}

export interface RenderedPage {
  html: string;
  /** Project path of the page that produced it. */
  file: string;
  /**
   * Content address of the module bundle, and the isolate's id. Identical sources
   * reuse a warm isolate instead of minting a new dynamic Worker.
   */
  bundleId: string;
}

/** No route in the project matches the pathname. */
export class RouteNotFoundError extends Error {
  constructor(readonly pathname: string) {
    super(`[pletivo-workers] no route matches ${JSON.stringify(pathname)}`);
    this.name = "RouteNotFoundError";
  }
}

/** The route matched, but this host cannot render that kind of page. */
export class UnsupportedRouteError extends Error {
  constructor(readonly file: string, reason: string) {
    super(`[pletivo-workers] cannot render ${JSON.stringify(file)}: ${reason}`);
    this.name = "UnsupportedRouteError";
  }
}

/**
 * TypeScript-only syntax at statement level, which the Loader cannot parse.
 * Line-anchored, because these words are ordinary inside a string or a comment.
 *
 * `compileProject` runs `stripTypes` over compiled `.astro` output, so frontmatter no
 * longer reaches here. One path is left: a `.js` / `.mjs` file in the map is taken at
 * its word and carried into the bundle verbatim, so a mis-named TypeScript file still
 * lands in the isolate — and this is what names it.
 */
const TYPESCRIPT_SYNTAX = [
  /^\s*(?:export\s+)?interface\s+[A-Za-z_$]/m,
  /^\s*(?:export\s+)?type\s+[A-Za-z_$][\w$]*\s*=/m,
  /^\s*(?:export\s+)?(?:declare|abstract\s+class)\b/m,
  /^\s*(?:export\s+)?(?:const\s+)?enum\s+[A-Za-z_$]/m,
];

/** Generated modules carrying TypeScript the isolate cannot run. */
export function typescriptSuspects(modules: Record<string, string>): string[] {
  return Object.keys(modules)
    .filter((name) => TYPESCRIPT_SYNTAX.some((pattern) => pattern.test(modules[name] ?? "")))
    .sort();
}

/**
 * The isolate refused the module bundle.
 *
 * An unresolvable specifier fails here identically to unparseable syntax, so the
 * TypeScript note is only attached when a module actually carries some. Blaming it
 * unconditionally sends whoever reads this hunting for annotations that may not
 * exist — which is what it used to do, and it cost a verification round.
 */
export class IsolateStartError extends Error {
  constructor(
    readonly reason: unknown,
    readonly suspects: string[] = [],
  ) {
    super(
      "[pletivo-workers] the render isolate could not run the module bundle." +
        (suspects.length
          ? " TypeScript syntax needs a transpiler inside the isolate and there is " +
            `none; it appears in ${suspects.join(", ")}.`
          : "") +
        `\n\n${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
    );
    this.name = "IsolateStartError";
  }
}

const DEFAULT_PAGES_DIR = "src/pages";
/**
 * Recent enough for `Response.json` and the modern module registry inside the
 * render isolate. The host worker's own date is set by its wrangler config.
 */
const DEFAULT_COMPATIBILITY_DATE = "2026-01-01";

/** Extensions `parseRoute` turns into routes. */
const PAGE_EXTENSIONS = [".astro", ".md", ".mdx", ".tsx", ".jsx", ".ts", ".js"];

// ── Routing ─────────────────────────────────────────────────────────

/**
 * The project's routes, ordered the way `scanRoutes` orders them on the Bun host:
 * static before dynamic, then by specificity.
 */
export function projectRoutes(
  files: ReadonlyMap<string, string>,
  pagesDir: string = DEFAULT_PAGES_DIR,
): Route[] {
  const prefix = pagesDir.endsWith("/") ? pagesDir : `${pagesDir}/`;
  const routes: Route[] = [];
  for (const file of files.keys()) {
    if (!file.startsWith(prefix)) continue;
    if (!PAGE_EXTENSIONS.some((extension) => file.endsWith(extension))) continue;
    routes.push(parseRoute(file.slice(prefix.length)));
  }
  routes.sort((a, b) => {
    if (a.isDynamic !== b.isDynamic) return (a.isDynamic ? 1 : 0) - (b.isDynamic ? 1 : 0);
    return a.priority - b.priority;
  });
  return routes;
}

// ── Rendering ───────────────────────────────────────────────────────

export async function renderPage(options: RenderPageOptions): Promise<RenderedPage> {
  const { files, pathname, loader, pagesDir = DEFAULT_PAGES_DIR, site } = options;
  const prefix = pagesDir.endsWith("/") ? pagesDir : `${pagesDir}/`;

  const match = findRoute(projectRoutes(files, pagesDir), pathname);
  if (!match) throw new RouteNotFoundError(pathname);
  const file = prefix + match.route.file;

  if (match.route.isDynamic) {
    throw new UnsupportedRouteError(
      file,
      "a dynamic route needs getStaticPaths(), which means executing the page module " +
        "on the host — only static routes render here",
    );
  }
  if (match.route.isEndpoint) {
    throw new UnsupportedRouteError(file, "endpoint routes are not implemented");
  }

  const source = files.get(file);
  if (source === undefined) throw new RouteNotFoundError(pathname);

  if (file.endsWith(".md")) {
    return { html: await renderMarkdownPage(source), file, bundleId: "" };
  }
  if (!isExecutableModule(file)) {
    throw new UnsupportedRouteError(file, "only .astro, .tsx and .md pages render here");
  }

  const project = await compileProject(files, options.compiler);
  const rendered = await renderModule({ project, file, params: match.params, loader, site, options });
  const css = pageCss({
    entry: file,
    styles: project.styles,
    imports: project.imports,
    html: rendered.html,
    renderedModules: new Set(rendered.renderedModules),
  });
  // A `.tsx` `<style>` is page-global and is hoisted by the JSX runtime rather than
  // scoped by the compiler, so it goes after the component CSS — where `writeHtml`
  // puts it on the Bun host.
  const styles = [css, rendered.tsxStyles.join("\n")].filter(Boolean).join("\n");
  return { html: finalizeHtml(rendered.html, styles), file, bundleId: rendered.bundleId };
}

/**
 * A `.md` page, rendered exactly as `build.ts` renders one: frontmatter for the
 * title, the body through the shared markdown pipeline, wrapped in a bare document.
 * No isolate involved — there is no module to execute.
 */
export async function renderMarkdownPage(source: string): Promise<string> {
  const { html, frontmatter } = await parseMarkdown(source);
  const title = typeof frontmatter.title === "string" ? frontmatter.title : "";
  return (
    `<!DOCTYPE html><html><head><meta charset="utf-8">` +
    `${title ? `<title>${title}</title>` : ""}</head><body>${html}</body></html>`
  );
}

interface IsolateResult {
  html: string;
  /** Project paths whose component function ran, for the `is:global` gate. */
  renderedModules: string[];
  /** `<style>` blocks a `.tsx` page hoisted, in the order they were reached. */
  tsxStyles: string[];
}

interface IsolateRender extends IsolateResult {
  bundleId: string;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isIsolateResult(value: unknown): value is IsolateResult {
  if (typeof value !== "object" || value === null) return false;
  return (
    typeof Reflect.get(value, "html") === "string" &&
    isStringArray(Reflect.get(value, "renderedModules")) &&
    isStringArray(Reflect.get(value, "tsxStyles"))
  );
}

async function renderModule(input: {
  project: CompiledProject;
  file: string;
  params: RouteParams;
  loader: WorkerLoaderBinding;
  site: string | undefined;
  options: RenderPageOptions;
}): Promise<IsolateRender> {
  const { project, file, params, loader, site, options } = input;
  const modules = { ...project.modules, [ENTRY_MODULE]: entryModule(project) };
  const bundleId = await bundleHash(modules);

  const stub = loader.get(bundleId, () => ({
    compatibilityDate: options.compatibilityDate ?? DEFAULT_COMPATIBILITY_DATE,
    compatibilityFlags: ["nodejs_compat"],
    mainModule: ENTRY_MODULE,
    modules,
    // The render is a pure function of the sources. Nothing it runs should reach
    // the network, and the isolate is running code the host just generated.
    globalOutbound: null,
  }));

  // The origin `build.ts` gives `Astro.url`: the configured site, or a localhost
  // stand-in. The request itself only carries the render instructions — the page's
  // own `Astro.request` is synthesized from `url` inside the isolate, matching a
  // static build, which has no request either.
  const origin = site ? new URL(site).origin : "http://localhost/";
  const request = new Request("http://pletivo.invalid/render", {
    method: "POST",
    body: JSON.stringify({ file, params, url: pageUrl(options.pathname, origin), site }),
  });
  let response: Response;
  try {
    response = await stub.getEntrypoint().fetch(request);
  } catch (error) {
    throw new IsolateStartError(error, typescriptSuspects(modules));
  }
  if (!response.ok) {
    throw new Error(`[pletivo-workers] rendering ${file} failed:\n${await response.text()}`);
  }
  const payload: unknown = await response.json();
  if (!isIsolateResult(payload)) {
    throw new Error(`[pletivo-workers] the render isolate returned an unexpected payload`);
  }
  return { ...payload, bundleId };
}

function pageUrl(pathname: string, origin: string): string {
  return new URL("/" + pathname.replace(/^\//, ""), origin).href;
}

/** Name of the generated module the isolate starts at. Never a project path. */
const ENTRY_MODULE = "pletivo-entry.js";

/**
 * The isolate's entry point.
 *
 * Pages are behind thunks rather than static imports so that rendering one route
 * does not evaluate every other page's module — the bundle holds the whole project,
 * and a sibling page that throws at module scope must not take this one down.
 *
 * The two page kinds are called differently, and the difference is not cosmetic: a
 * compiled `.astro` default export takes `(result, props, slots)` and a `.tsx` one
 * takes plain props, so handing an Astro result object to a JSX component would give
 * it the render result as its props. `isAstroComponent` is the same test `build.ts`
 * splits on.
 */
function entryModule(project: CompiledProject): string {
  const pages = [...project.moduleNames]
    .filter(([file]) => isExecutableModule(file))
    .map(([file, name]) => `  ${JSON.stringify(file)}: () => import(${JSON.stringify(`./${name}`)}),`)
    .join("\n");

  return `import { isAstroComponent, redirectPageHtml, renderAstroPage, runWithRenderTracking } from ${JSON.stringify(`./${RUNTIME_MODULE_NAME}`)};

const PAGES = {
${pages}
};

async function renderPageComponent(component, pageContext) {
  if (isAstroComponent(component)) return renderAstroPage(component, {}, pageContext);
  const output = await component({ __pageContext: pageContext });
  if (typeof output === "string") return output;
  // A static file cannot send a 3xx, so a redirect becomes the meta-refresh page
  // Astro's static output emits. Any other Response has no static equivalent.
  if (output instanceof Response) {
    return output.headers.get("location") ? redirectPageHtml(output) : "";
  }
  if (output && typeof output === "object" && "__html" in output) return output.__html;
  return "";
}

export default {
  async fetch(request) {
    const { file, params, url, site } = await request.json();
    const load = PAGES[file];
    if (!load) return new Response("no module for " + file, { status: 404 });
    const module = await load();
    if (typeof module.default !== "function") {
      return new Response(file + " has no default export", { status: 500 });
    }
    const { value, renderedModules, tsxStyles } = await runWithRenderTracking(() =>
      renderPageComponent(module.default, {
        url: new URL(url),
        site: site ? new URL(site) : undefined,
        params,
        preferredLocaleList: [],
      }),
    );
    return Response.json({
      html: value ?? "",
      renderedModules: [...renderedModules],
      tsxStyles,
    });
  },
};
`;
}

/**
 * Content address of a module map. Same sources, same id, same warm isolate —
 * `env.LOADER.get` only calls the factory when it has nothing cached under the id.
 */
export async function bundleHash(modules: Record<string, string>): Promise<string> {
  const text = Object.keys(modules)
    .sort()
    .map((name) => `${name} ${modules[name]}`)
    .join(" ");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
