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
 *
 * ## Dynamic routes are one call, and that is forced
 *
 * `build.ts` calls `getStaticPaths({ paginate })` on the imported page module, and
 * its own comment explains why it only ever carries the *params* across a cache
 * boundary: a collection-backed route's props hold `render()` methods. Props are not
 * serializable, so they can never leave the isolate. Asking the isolate for a path
 * list and then rendering out here would break on the first such route.
 *
 * So the host asks for *pathname X of route file Y* and the isolate does the whole
 * thing internally — import, `getStaticPaths`, match, render. `projectPaths` is the
 * other half, for a preview index or a sitemap: it returns params and nothing else,
 * which is exactly the part that is JSON-safe.
 */

import {
  findRoute,
  parseRoute,
  routeToOutputPath,
  type Route,
  type RouteParams,
} from "@pletivo/core/router";
import { parseMarkdown } from "@pletivo/core/content/markdown";
import type { AstroCompiler } from "./astro-compiler.ts";
import { compileProject, isExecutableModule, type CompiledProject } from "./compile-project.ts";
import { finalizeHtml, pageCss } from "./page-css.ts";
import {
  cssRoots,
  isCollectableCss,
  parentDir,
  projectStylesheet,
  type ProjectStylesheet,
} from "./project-css.ts";
import type { TailwindStylesheets } from "./tailwind.ts";
import type { ContentBinding, ContentStore } from "./content-files.ts";
import {
  assertEnvFits,
  envModules,
  envPayload,
  ENV_BINDING,
  ENV_CLIENT_MODULE_NAME,
  ENV_INSTALL,
  ENV_SERVER_MODULE_NAME,
  type EnvPayload,
  type ProjectEnv,
} from "./env.ts";
import {
  outboundConfig,
  outboundKind,
  type OutboundAccess,
  type OutboundBinding,
} from "./outbound.ts";
import {
  CONTENT_MODULE_NAME,
  GENERATED_MODULES,
  RUNTIME_MODULE_NAME,
} from "./generated/runtime-modules.ts";

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
  /**
   * `null` cuts the isolate off from the network, a binding proxies it — and *absent*
   * inherits the host worker's own access. `ProjectOptions.outbound` is what decides
   * which; nothing here ever leaves the field out by accident. See `outbound.ts`.
   */
  globalOutbound?: OutboundBinding | null;
  /**
   * Bindings the isolate gets, independent of `globalOutbound` — a capability is not
   * the network. Set once, when the isolate is created: `get()` only calls the code
   * factory on a cache miss, so nothing per-request can ride here.
   */
  env?: Record<string, unknown>;
}

export interface DynamicWorkerStub {
  getEntrypoint(): { fetch(request: Request): Promise<Response> };
}

export interface WorkerLoaderBinding {
  get(id: string, code: () => DynamicWorkerCode | Promise<DynamicWorkerCode>): DynamicWorkerStub;
}

// ── Options and results ─────────────────────────────────────────────

/**
 * How the isolate reads content files, for a project that has collections.
 *
 * Two halves because only the app has `ctx.exports`: it owns the store and wraps it
 * in a `WorkerEntrypoint`, and hands back the loopback stub. See `content-files.ts`
 * for the shape, and for why every call carries a ref.
 */
export interface ContentAccess {
  /** The loopback stub the isolate calls, e.g. `ctx.exports.PletivoContent({})`. */
  binding: ContentBinding;
  /** Where the bytes come from. A handle is opened per render and closed after it. */
  store: ContentStore;
}

/** What every entrypoint here needs: the project, and somewhere to run it. */
export interface ProjectOptions {
  /** The project: path (no leading slash, `/` separators) -> source text. */
  files: ReadonlyMap<string, string>;
  loader: WorkerLoaderBinding;
  /** Where pages live in `files`. */
  pagesDir?: string;
  /** Where the source tree starts in `files`. Defaults to the parent of `pagesDir`. */
  srcDir?: string;
  /** Where the project root starts in `files`. Defaults to the parent of `srcDir`. */
  rootDir?: string;
  /** `compatibility_date` for the render isolate. */
  compatibilityDate?: string;
  /**
   * Overrides the compiler bound to the bundled `astro.wasm`. Only a test outside
   * a Worker needs this — see `compileProject`.
   */
  compiler?: AstroCompiler;
  /**
   * Required only when the project has content collections. Without it such a project
   * throws `ContentUnavailableError` rather than rendering a page with empty ones.
   */
  content?: ContentAccess;
  /**
   * What the isolate may reach over the network. Omitted, it reaches nothing — a page
   * that calls `fetch()` throws rather than quietly getting out. See `outbound.ts`
   * for the three states and why they are named rather than optional.
   */
  outbound?: OutboundAccess;
  /**
   * What `astro:env/client` and `astro:env/server` export inside the isolate.
   *
   * The host's own configuration — its `vars` and secrets — not the project's, since
   * nothing here evaluates `astro.config.*`. A name the project imports and this does
   * not carry arrives as `undefined`, which is what the Bun host gives for an unset
   * `process.env` entry. Capped at 1 MiB; see `env.ts`.
   */
  env?: ProjectEnv;
}

export interface RenderPageOptions extends ProjectOptions {
  /** URL pathname to render, e.g. `/` or `/blog/hello`. */
  pathname: string;
  /** `site` from the project config. Sets the origin of `Astro.url`. */
  site?: string;
  /**
   * Tailwind's own stylesheets, as text. Needed only when a project stylesheet does
   * `@import "tailwindcss"`; without them that project throws rather than rendering
   * unstyled. The isolate cannot read them off disk, so the host worker's bundler has
   * to embed them — see `packages/workers/example/src/index.ts`.
   */
  tailwind?: TailwindStylesheets;
}

/** A file the rendered HTML references, which the host has to serve for the page to work. */
export interface RenderedAsset {
  /** Root-absolute URL path, exactly as the HTML spells it. */
  path: string;
  contentType: string;
  body: string;
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
  /**
   * Generated files the HTML links to — today, the project stylesheet. Same for every
   * page of a project, and named by its own content hash, so a host can serve them
   * from one map and cache them forever.
   */
  assets: RenderedAsset[];
}

/** No route in the project matches the pathname. */
export class RouteNotFoundError extends Error {
  constructor(
    readonly pathname: string,
    message = `[pletivo-workers] no route matches ${JSON.stringify(pathname)}`,
  ) {
    super(message);
    this.name = "RouteNotFoundError";
  }
}

/** Why a dynamic route that matched the pathname still renders no page. */
export type UnresolvedReason = "no-static-path" | "not-enumerable";

const UNRESOLVED_REASONS: Readonly<Record<UnresolvedReason, string>> = {
  "no-static-path": "getStaticPaths() returned no entry for these params",
  "not-enumerable":
    "the route declares neither getStaticPaths() nor `prerender = false`, so nothing " +
    "says what its paths are",
};

/**
 * A dynamic route matched the pathname and then produced no page.
 *
 * Still a `RouteNotFoundError`, because to whoever asked for the URL it is the same
 * 404 the Bun dev server gives. The reason is worth carrying anyway: `no-static-path`
 * means the author's own path list does not hold this one, while `not-enumerable`
 * means the route never said what its paths are — which a preview server may want to
 * surface rather than swallow.
 */
export class RoutePathNotFoundError extends RouteNotFoundError {
  constructor(
    pathname: string,
    readonly file: string,
    readonly reason: UnresolvedReason,
  ) {
    super(
      pathname,
      `[pletivo-workers] ${JSON.stringify(file)} matched ${JSON.stringify(pathname)} ` +
        `but renders no page: ${UNRESOLVED_REASONS[reason]}`,
    );
    this.name = "RoutePathNotFoundError";
  }
}

/**
 * The project has content collections and nothing was given to read them with.
 *
 * Loud rather than lenient: without a binding `getCollection()` inside the isolate
 * would have no sources at all, and a blog index would render as an empty list — a
 * page that looks fine and is wrong.
 */
export class ContentUnavailableError extends Error {
  constructor() {
    super(
      "[pletivo-workers] this project imports the content API, so the render isolate " +
        "needs a binding to read content files with. Pass `content: { binding, store }` " +
        "— see ContentFiles in content-files.ts.",
    );
    this.name = "ContentUnavailableError";
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

/**
 * Generated modules carrying TypeScript the isolate cannot run.
 *
 * The pre-bundled modules are skipped, and not as an optimisation: they are Bun's own
 * output, so they cannot hold TypeScript — but `pletivo-content.js` carries a
 * megabyte of vendored JavaScript, and somewhere in it a line begins `type … =`. Left
 * in, it made every isolate failure in a content project blame a file with nothing
 * wrong with it, which is the exact mistake `1101194` was about.
 */
export function typescriptSuspects(modules: Record<string, string>): string[] {
  return Object.keys(modules)
    .filter((name) => !(name in GENERATED_MODULES))
    .filter((name) => TYPESCRIPT_SYNTAX.some((pattern) => pattern.test(modules[name] ?? "")))
    .sort();
}

/**
 * The isolate refused the module bundle — it never got as far as running a page.
 *
 * An unresolvable specifier fails here identically to unparseable syntax, so the
 * TypeScript note is only attached when a module actually carries some. Blaming it
 * unconditionally sends whoever reads this hunting for annotations that may not
 * exist — which is what it used to do, and it cost a verification round.
 *
 * A page that throws *while rendering* does not come here: the generated entry catches
 * it and answers with a 500, so the two are told apart rather than guessed at. Denied
 * network access is the case that made this matter — workerd's own message names the
 * cause precisely, and it used to arrive under a headline blaming the bundle.
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

/** One page the project can render, named the way `renderPage` wants to be asked. */
export interface RoutePath {
  /** Project path of the page file. */
  file: string;
  /** URL pathname — pass this straight back to `renderPage`. */
  pathname: string;
  params: RouteParams;
}

/**
 * Every page the project can enumerate: the static routes, plus one entry per param
 * set each `getStaticPaths()` returns.
 *
 * The JSON-safe half of the dynamic-route problem, and the only half there is out
 * here — props stay in the isolate, so this is params and nothing else. What is
 * deliberately absent: `prerender = false` routes (there is no path list to
 * enumerate, which is the point of them), routes that declare neither, and endpoints.
 * `renderPage` still serves an on-demand route when asked for a concrete pathname.
 *
 * The isolate is only started when the project has a dynamic route at all.
 */
export async function projectPaths(options: ProjectOptions): Promise<RoutePath[]> {
  const pagesDir = options.pagesDir ?? DEFAULT_PAGES_DIR;
  const prefix = pagesDir.endsWith("/") ? pagesDir : `${pagesDir}/`;
  const routes = projectRoutes(options.files, pagesDir).filter((route) => !route.isEndpoint);
  const enumerable = routes.filter(
    (route) => route.isDynamic && isExecutableModule(prefix + route.file),
  );

  const paramSets = enumerable.length === 0 ? new Map<string, RouteParams[]>() :
    await isolatePaths(enumerable, prefix, options);

  const paths: RoutePath[] = [];
  for (const route of routes) {
    const file = prefix + route.file;
    if (!route.isDynamic) {
      paths.push({ file, pathname: routePathname(route, {}), params: {} });
      continue;
    }
    for (const params of paramSets.get(file) ?? []) {
      paths.push({ file, pathname: routePathname(route, params), params });
    }
  }
  return paths;
}

/**
 * The URL a route with these params is served at.
 *
 * Derived from `routeToOutputPath` rather than from the segments directly, so it is
 * exactly the file `pletivo build` would have written — and then the same directory
 * URL `toPathname` gives that file, trailing slash included. `paginate` builds its
 * `page.url` links the same way, so a page's own links and this list agree.
 */
function routePathname(route: Route, params: RouteParams): string {
  const output = routeToOutputPath(route, params);
  return "/" + (output.endsWith(INDEX_HTML) ? output.slice(0, -INDEX_HTML.length) : output);
}

const INDEX_HTML = "index.html";

/** Ask the isolate for each route's param sets. One call, however many routes. */
async function isolatePaths(
  routes: Route[],
  prefix: string,
  options: ProjectOptions,
): Promise<Map<string, RouteParams[]>> {
  const project = await compileProject(options.files, options.compiler);
  const { payload } = await callIsolate({
    project,
    options,
    label: "resolving getStaticPaths",
    body: {
      op: "paths",
      routes: routes.map((route) => ({ file: prefix + route.file, route })),
    },
  });
  if (!isPathsPayload(payload)) {
    throw new Error("[pletivo-workers] the isolate returned an unexpected getStaticPaths payload");
  }
  return new Map(
    Object.entries(payload.paths).map(([file, sets]) => [file, sets.map(decodeParams)]),
  );
}

// ── Rendering ───────────────────────────────────────────────────────

export async function renderPage(options: RenderPageOptions): Promise<RenderedPage> {
  const { files, pathname, loader, pagesDir = DEFAULT_PAGES_DIR, site } = options;
  const prefix = pagesDir.endsWith("/") ? pagesDir : `${pagesDir}/`;

  const match = findRoute(projectRoutes(files, pagesDir), pathname);
  if (!match) throw new RouteNotFoundError(pathname);
  const file = prefix + match.route.file;

  if (match.route.isEndpoint) {
    throw new UnsupportedRouteError(file, "endpoint routes are not implemented");
  }

  const source = files.get(file);
  if (source === undefined) throw new RouteNotFoundError(pathname);

  if (file.endsWith(".md")) {
    // A markdown page has no module, so it can declare neither a path list nor the
    // on-demand opt-out — a dynamic one is unresolvable by construction.
    if (match.route.isDynamic) {
      throw new RoutePathNotFoundError(pathname, file, "not-enumerable");
    }
    // The stylesheet is the whole project's, so a `.md` page links the same one every
    // other page does — which costs it the project compile it otherwise never needs.
    // Only when the project has a stylesheet at all: the common CSS-free markdown site
    // still renders without ever touching the wasm compiler.
    const stylesheet = hasStylesheet(files)
      ? await siteStylesheet(await compileProject(files, options.compiler), options)
      : null;
    const html = finalizeHtml(await renderMarkdownPage(source), "", stylesheet?.href ?? null);
    return { html, file, bundleId: "", assets: assetsOf(stylesheet) };
  }
  if (!isExecutableModule(file)) {
    throw new UnsupportedRouteError(file, "only .astro, .tsx and .md pages render here");
  }

  const project = await compileProject(files, options.compiler);
  const stylesheet = await siteStylesheet(project, options);
  const rendered = await renderModule({
    project,
    file,
    params: match.params,
    // A static route needs none of the getStaticPaths machinery, and the isolate
    // tells the two apart by whether it was handed a route.
    route: match.route.isDynamic ? match.route : null,
    site,
    options,
  });
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
  return {
    html: finalizeHtml(rendered.html, styles, stylesheet?.href ?? null),
    file,
    bundleId: rendered.bundleId,
    assets: assetsOf(stylesheet),
  };
}

/** Whether anything in the project could produce a stylesheet at all. */
function hasStylesheet(files: ReadonlyMap<string, string>): boolean {
  for (const file of files.keys()) if (isCollectableCss(file)) return true;
  return false;
}

/**
 * The project's one stylesheet, built from the graph `compileProject` produced.
 *
 * Every page of a project gets the same file, so the walk covers every route rather
 * than the one being rendered — a page's own `<style>` blocks are the per-page part,
 * and those go through `pageCss`.
 */
async function siteStylesheet(
  project: CompiledProject,
  options: RenderPageOptions,
): Promise<ProjectStylesheet | null> {
  const pagesDir = options.pagesDir ?? DEFAULT_PAGES_DIR;
  const srcDir = options.srcDir ?? parentDir(pagesDir);
  const prefix = pagesDir.endsWith("/") ? pagesDir : `${pagesDir}/`;
  const pages = new Map(
    projectRoutes(options.files, pagesDir).map((route) => [prefix + route.file, route.file]),
  );
  return projectStylesheet({
    files: options.files,
    srcDir,
    rootDir: options.rootDir ?? parentDir(srcDir),
    cssImports: project.cssImports,
    imports: project.imports,
    roots: cssRoots({ pages, imports: project.imports }),
    tailwind: options.tailwind,
  });
}

function assetsOf(stylesheet: ProjectStylesheet | null): RenderedAsset[] {
  if (!stylesheet) return [];
  return [{ path: stylesheet.href, contentType: "text/css; charset=utf-8", body: stylesheet.css }];
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

/**
 * How params cross the isolate boundary.
 *
 * Not as an object: `undefined` is a real param value — a rest segment that matched
 * nothing, which is how `[...page]` names its first page — and `JSON.stringify` drops
 * a key whose value is `undefined`. Sent as an object, `{ page: undefined }` would
 * arrive as `{}` and match the wrong entry of `getStaticPaths`. Pairs with `null`
 * survive the round trip.
 */
type ParamPair = [string, string | null];

function encodeParams(params: RouteParams): ParamPair[] {
  return Object.keys(params).map((name): ParamPair => [name, params[name] ?? null]);
}

function decodeParams(pairs: ParamPair[]): RouteParams {
  const params: RouteParams = {};
  for (const [name, value] of pairs) params[name] = value === null ? undefined : value;
  return params;
}

interface RenderedPayload {
  status: "rendered";
  html: string;
  /** Project paths whose component function ran, for the `is:global` gate. */
  renderedModules: string[];
  /** `<style>` blocks a `.tsx` page hoisted, in the order they were reached. */
  tsxStyles: string[];
}

/** The dynamic route matched no path. Params only — no props were ever produced. */
interface UnresolvedPayload {
  status: "unresolved";
  reason: UnresolvedReason;
}

/** Project path -> the param sets its `getStaticPaths()` returned. */
interface PathsPayload {
  status: "paths";
  paths: Record<string, ParamPair[][]>;
}

interface IsolateRender extends RenderedPayload {
  bundleId: string;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** Narrows enough for `Reflect.get`, which is how every payload here is read. */
function hasStatus(value: unknown, status: string): value is object {
  if (typeof value !== "object" || value === null) return false;
  return Reflect.get(value, "status") === status;
}

function isRenderedPayload(value: unknown): value is RenderedPayload {
  if (!hasStatus(value, "rendered")) return false;
  return (
    typeof Reflect.get(value, "html") === "string" &&
    isStringArray(Reflect.get(value, "renderedModules")) &&
    isStringArray(Reflect.get(value, "tsxStyles"))
  );
}

function isUnresolvedPayload(value: unknown): value is UnresolvedPayload {
  if (!hasStatus(value, "unresolved")) return false;
  const reason = Reflect.get(value, "reason");
  return reason === "no-static-path" || reason === "not-enumerable";
}

function isParamPair(value: unknown): value is ParamPair {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const [name, param]: unknown[] = value;
  return typeof name === "string" && (typeof param === "string" || param === null);
}

function isPathsPayload(value: unknown): value is PathsPayload {
  if (!hasStatus(value, "paths")) return false;
  const paths = Reflect.get(value, "paths");
  if (typeof paths !== "object" || paths === null) return false;
  return Object.values(paths).every(
    (sets: unknown) =>
      Array.isArray(sets) &&
      sets.every((set: unknown) => Array.isArray(set) && set.every(isParamPair)),
  );
}

/**
 * One round trip to the render isolate, whichever question is being asked.
 *
 * The module map is the whole project and nothing else, so it stays content-addressed
 * — every per-request value rides in the request body, and identical sources keep
 * reusing one warm isolate however many pathnames are rendered from them.
 */
async function callIsolate(input: {
  project: CompiledProject;
  options: ProjectOptions;
  /** Names the operation in an error, e.g. `rendering src/pages/index.astro`. */
  label: string;
  body: Record<string, unknown>;
}): Promise<{ bundleId: string; payload: unknown }> {
  const { project, options, label, body } = input;
  // The env values are not in the map — only the names their modules export, which is
  // forced: ESM decides its exports statically. Rotating a secret leaves the bundle,
  // and therefore the warm isolate, exactly where it was.
  const env = project.env === null ? null : envPayload(options.env);
  assertEnvFits(env);
  const modules = {
    ...project.modules,
    ...(project.env === null ? {} : envModules(project.env, env)),
    [ENTRY_MODULE]: entryModule(project),
  };
  const bundleId = await bundleHash(modules);

  const content = project.content === null ? null : options.content;
  if (project.content !== null && !content) throw new ContentUnavailableError();

  const isolateEnv = {
    ...(content ? { [CONTENT_BINDING]: content.binding } : {}),
    ...(env ? { [ENV_BINDING]: env } : {}),
  };

  const stub = options.loader.get(await isolateId(bundleId, options, env), () => ({
    compatibilityDate: options.compatibilityDate ?? DEFAULT_COMPATIBILITY_DATE,
    compatibilityFlags: ["nodejs_compat"],
    mainModule: ENTRY_MODULE,
    modules,
    // Cut off unless the caller said otherwise, because a render is a pure function
    // of its sources and this is code the host generated a millisecond ago. The
    // bindings below are unaffected either way: a capability is not the network.
    ...outboundConfig(options.outbound),
    ...(Object.keys(isolateEnv).length > 0 ? { env: isolateEnv } : {}),
  }));

  // Opened per render, not per isolate: the isolate outlives the request that made
  // it, so the sources have to be named by something that travels with the request.
  const handle = content ? content.store.open(options.files) : null;
  const request = new Request("http://pletivo.invalid/render", {
    method: "POST",
    body: JSON.stringify(
      handle ? { ...body, contentRef: handle.ref, rootDir: projectRoot(options) } : body,
    ),
  });
  let response: Response;
  try {
    response = await stub.getEntrypoint().fetch(request);
  } catch (error) {
    throw new IsolateStartError(error, typescriptSuspects(modules));
  } finally {
    handle?.close();
  }
  if (!response.ok) {
    throw new Error(`[pletivo-workers] ${label} failed:\n${await response.text()}`);
  }
  return { bundleId, payload: await response.json() };
}

/** Where the project root sits in `files`, which is what a collection base resolves against. */
function projectRoot(options: ProjectOptions): string {
  const pagesDir = options.pagesDir ?? DEFAULT_PAGES_DIR;
  return options.rootDir ?? parentDir(options.srcDir ?? parentDir(pagesDir));
}

async function renderModule(input: {
  project: CompiledProject;
  file: string;
  params: RouteParams;
  /** The matched route when it is dynamic, `null` when it is static. */
  route: Route | null;
  site: string | undefined;
  options: RenderPageOptions;
}): Promise<IsolateRender> {
  const { project, file, params, route, site, options } = input;

  // The origin `build.ts` gives `Astro.url`: the configured site, or a localhost
  // stand-in. The request itself only carries the render instructions — the page's
  // own `Astro.request` is synthesized from `url` inside the isolate, matching a
  // static build, which has no request either.
  const origin = site ? new URL(site).origin : "http://localhost/";
  const { bundleId, payload } = await callIsolate({
    project,
    options,
    label: `rendering ${file}`,
    body: {
      op: "render",
      file,
      params: encodeParams(params),
      route,
      url: pageUrl(options.pathname, origin),
      site,
    },
  });
  if (isUnresolvedPayload(payload)) {
    throw new RoutePathNotFoundError(options.pathname, file, payload.reason);
  }
  if (!isRenderedPayload(payload)) {
    throw new Error(`[pletivo-workers] the render isolate returned an unexpected payload`);
  }
  return { ...payload, bundleId };
}

function pageUrl(pathname: string, origin: string): string {
  return new URL("/" + pathname.replace(/^\//, ""), origin).href;
}

/** Name of the generated module the isolate starts at. Never a project path. */
const ENTRY_MODULE = "pletivo-entry.js";

/** What the content binding is called in the isolate's `env`. */
const CONTENT_BINDING = "PLETIVO_CONTENT";

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
 *
 * This is also the only place `getStaticPaths` can run: it hands back props holding
 * `render()` methods, so nothing it returns may be serialized back to the host. The
 * `render` op therefore resolves and renders in one go; the `paths` op returns the
 * params and drops the props on the floor, which is what makes it JSON-safe.
 */
function entryModule(project: CompiledProject): string {
  const pages = [...project.moduleNames]
    .filter(([file]) => isExecutableModule(file))
    .map(([file, name]) => `  ${JSON.stringify(file)}: () => import(${JSON.stringify(`./${name}`)}),`)
    .join("\n");

  return `import { createPaginate, isAstroComponent, redirectPageHtml, renderAstroPage, runWithRenderTracking } from ${JSON.stringify(`./${RUNTIME_MODULE_NAME}`)};
${contentPrelude(project)}${envPrelude(project)}
const PAGES = {
${pages}
};

// The Workers host has no \`base\` yet, so paginate's URLs are root-relative — the
// same output a project built with \`base: "/"\` gets.
const BASE = "/";

// \`undefined\` is a real param value and JSON drops it; see ParamPair in render.ts.
function decodeParams(pairs) {
  const params = {};
  for (const [name, value] of pairs) params[name] = value === null ? undefined : value;
  return params;
}

function encodeParams(params) {
  return Object.keys(params).map((name) => [name, params[name] ?? null]);
}

function loadPage(file) {
  const load = PAGES[file];
  return load ? load() : null;
}

/**
 * What a dynamic route renders with — or why it renders nothing.
 *
 * The three kinds the Bun host has, in the order it tests them: an enumerable route
 * renders only what \`getStaticPaths()\` listed, \`prerender = false\` takes its params
 * from the URL, and a route that declares neither stays a 404.
 */
async function resolveDynamic(module, route, urlParams) {
  if (typeof module.getStaticPaths === "function") {
    const paths = await module.getStaticPaths({ paginate: createPaginate(route, BASE) });
    const match = paths.find((entry) =>
      Object.keys(urlParams).every((name) => entry.params[name] === urlParams[name]),
    );
    if (!match) return { unresolved: "no-static-path" };
    // \`Astro.params\` is the path's own param set, not the URL's — build.ts renders
    // from the getStaticPaths entry, which may carry params no URL segment names.
    return { params: match.params, props: match.props || {} };
  }
  if (module.prerender === false) return { params: urlParams, props: {} };
  return { unresolved: "not-enumerable" };
}

async function renderPageComponent(component, props, pageContext) {
  if (isAstroComponent(component)) return renderAstroPage(component, props, pageContext);
  const output = await component({ ...props, __pageContext: pageContext });
  if (typeof output === "string") return output;
  // A static file cannot send a 3xx, so a redirect becomes the meta-refresh page
  // Astro's static output emits. Any other Response has no static equivalent.
  if (output instanceof Response) {
    return output.headers.get("location") ? redirectPageHtml(output) : "";
  }
  if (output && typeof output === "object" && "__html" in output) return output.__html;
  return "";
}

async function listPaths(routes) {
  const paths = {};
  for (const { file, route } of routes) {
    const module = await loadPage(file);
    if (!module || typeof module.getStaticPaths !== "function") continue;
    const list = await module.getStaticPaths({ paginate: createPaginate(route, BASE) });
    paths[file] = list.map((entry) => encodeParams(entry.params));
  }
  return Response.json({ status: "paths", paths });
}

async function render({ file, params, route, url, site }) {
  const module = await loadPage(file);
  if (!module) return new Response("no module for " + file, { status: 404 });
  if (typeof module.default !== "function") {
    return new Response(file + " has no default export", { status: 500 });
  }
  let pageParams = decodeParams(params);
  let props = {};
  if (route) {
    const resolved = await resolveDynamic(module, route, pageParams);
    if (resolved.unresolved) {
      return Response.json({ status: "unresolved", reason: resolved.unresolved });
    }
    pageParams = resolved.params;
    props = resolved.props;
  }
  const { value, renderedModules, tsxStyles } = await runWithRenderTracking(() =>
    renderPageComponent(module.default, props, {
      url: new URL(url),
      site: site ? new URL(site) : undefined,
      params: pageParams,
      preferredLocaleList: [],
    }),
  );
  return Response.json({
    status: "rendered",
    html: value ?? "",
    renderedModules: [...renderedModules],
    tsxStyles,
  });
}

export default {
  async fetch(request, env) {
    // Everything below this line is a *render* failure, not a bundle that would not
    // run — the bundle plainly ran, it is running now. Reported as a response rather
    // than as a throw because an exception crossing the Loader boundary looks
    // identical to one thrown while starting, and the host would have to guess.
    // \`await\` on both branches, or the rejection leaves the try block unseen.
    try {
      const body = await request.json();
      openEnv(env);
      await openContent(env, body);
      return body.op === "paths" ? await listPaths(body.routes) : await render(body);
    } catch (error) {
      return new Response((error && error.stack) || String(error), { status: 500 });
    }
  },
};
`;
}

/**
 * The isolate's `astro:env` wiring, emitted only for a project that imports it.
 *
 * Before anything else, and before the first page module is loaded: a page reads its
 * configuration in frontmatter, which runs the moment the module is imported.
 *
 * Unlike the content prelude, this one is safe to leave as module state. The values
 * come out of the isolate's own `env`, which is fixed when the isolate is created, so
 * every request installs the identical thing — there is no per-request value here for
 * an overlapping render to see. What makes that true is the isolate id covering the
 * env values: two different sets of values are two different isolates.
 */
function envPrelude(project: CompiledProject): string {
  if (project.env === null) return "\nfunction openEnv() {}\n";
  const imports: string[] = [];
  const installs: string[] = [];
  const use = (names: string[] | null, local: string, module: string): void => {
    if (names === null) return;
    imports.push(`import * as ${local} from ${JSON.stringify(`./${module}`)};`);
    installs.push(`  ${local}.${ENV_INSTALL}(values);`);
  };
  use(project.env.client, "$$envClient", ENV_CLIENT_MODULE_NAME);
  use(project.env.server, "$$envServer", ENV_SERVER_MODULE_NAME);

  return `${imports.join("\n")}

function openEnv(env) {
  const values = (env && env[${JSON.stringify(ENV_BINDING)}]) || {};
${installs.join("\n")}
}
`;
}

/**
 * The isolate's content wiring, emitted only for a project that reaches for the API.
 *
 * Two things have to happen on **every** request, and both are consequences of the
 * isolate being reused on purpose:
 *
 *  - the `ContentHost` is re-installed, because the binding call has to carry this
 *    request's ref — the stub in `env` was made for the first request and knows
 *    nothing about this one;
 *  - `initCollections` runs, which drops every cached entry. A store that survived
 *    would answer the next render with the previous render's markdown, and since a
 *    content edit does *not* change the module map, that next render is exactly the
 *    one an author is watching for.
 *
 * The config module sits behind a thunk for the same reason pages do: a throw at its
 * module scope should fail the render that needed it, not the isolate.
 */
function contentPrelude(project: CompiledProject): string {
  if (project.content === null) {
    return "\nasync function openContent() {}\n";
  }
  const { configModule } = project.content;
  return `import { initCollections, setContentHost } from ${JSON.stringify(`./${CONTENT_MODULE_NAME}`)};

const CONTENT_CONFIG = ${configModule === null ? "null" : `() => import(${JSON.stringify(`./${configModule}`)})`};

/** Project paths are \`/\`-joined keys of a virtual file map, never filesystem paths. */
function joinPath(dir, name) {
  if (!dir) return name;
  return name ? dir + "/" + name : dir;
}

async function openContent(env, body) {
  const files = env && env[${JSON.stringify(CONTENT_BINDING)}];
  if (!files) throw new Error("[pletivo-workers] the render isolate has no content binding");
  const ref = body.contentRef;
  setContentHost({
    async scan(projectRoot, base, pattern) {
      const dir = joinPath(projectRoot, base);
      return {
        root: dir,
        // A virtual key is not a filesystem path, so this URL is rooted at the file
        // map rather than at the machine. \`generateId\` reading \`base\` therefore sees
        // a different absolute prefix than it would on the Bun host.
        rootUrl: new URL("file:///" + dir + "/"),
        files: await files.scan(ref, dir, pattern),
      };
    },
    async readFile(path) {
      const text = await files.read(ref, path);
      if (text === null) throw new Error("[pletivo-workers] no content file " + path);
      return text;
    },
    dirname(path) {
      const at = path.lastIndexOf("/");
      return at === -1 ? "" : path.slice(0, at);
    },
    resolveDir: joinPath,
    async loadConfig() {
      if (!CONTENT_CONFIG) return {};
      const module = await CONTENT_CONFIG();
      return module.collections || {};
    },
  });
  await initCollections(body.rootDir || "");
}
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
  return digestHex(text, 16);
}

async function digestHex(text: string, bytes: number): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)]
    .slice(0, bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * What the isolate is cached under: the sources, plus the configuration that cannot
 * be changed after it is created.
 *
 * `env.LOADER.get(id, code)` runs `code` on a cache miss and never again, so
 * everything in it — `globalOutbound`, `env` — belongs to the *first* render that
 * asked for that id. The module map is content-addressed, which takes care of the
 * sources; the rest of the code object is not in the map, and an id that ignored it
 * would hand the second caller the first caller's network policy.
 *
 * A default configuration adds nothing: cut off, with no env values, the id is
 * exactly `bundleHash(modules)`, so identical sources keep reusing one isolate the
 * way they always have. Only a caller asking for something else pays for a second
 * one, and pays once — the suffix is a hash of the configuration, not of the request.
 *
 * The one thing it cannot cover is *which* proxy: a stub is a fresh object every
 * request and nothing in it identifies the service behind it. A host serving several
 * tenants with different proxies over identical sources therefore has to vary
 * something this id does see — a tenant id among the env values is enough.
 */
async function isolateId(
  bundleId: string,
  options: ProjectOptions,
  env: EnvPayload | null,
): Promise<string> {
  const outbound = outboundKind(options.outbound);
  if (outbound === "blocked" && env === null) return bundleId;
  return `${bundleId}.${await digestHex(JSON.stringify({ outbound, env }), 8)}`;
}
