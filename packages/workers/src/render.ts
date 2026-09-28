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
import { projectModuleId } from "./artifact.ts";
import type { ProjectArtifact } from "./project-artifact.ts";
import type { AstroCompiler } from "./astro-compiler.ts";
import type { CompileCache } from "./compile-cache.ts";
import { compileProject, isExecutableModule, type CompiledProject } from "./compile-project.ts";
import { finalizeHtml, pageCss } from "./page-css.ts";
import { pageStylesheet, parentDir } from "./project-css.ts";
import type { TailwindStylesheets } from "./tailwind.ts";
import type { ProjectAssetsView } from "./asset-port.ts";
import type { ContentBinding, ContentStore } from "./content-files.ts";
import {
  assertEnvFits,
  envModules,
  envPayload,
  ENV_BINDING,
  ENV_CLIENT_MODULE_NAME,
  ENV_INSTALL,
  ENV_SERVER_MODULE_NAME,
  importMetaEnvPayload,
  IMPORT_META_ENV_BINDING,
  type ProjectEnv,
} from "./env.ts";
import {
  outboundConfig,
  outboundKind,
  type OutboundAccess,
  type OutboundBinding,
} from "./outbound.ts";
import {
  ExecutionIdentityError,
  isolateKey,
  programHash,
  type ExecutionNamespace,
} from "./execution-identity.ts";
import {
  CONTENT_BINDING,
  decodeParams,
  encodeParams,
  ISOLATE_PROTOCOL_VERSION,
  IsolateProtocolError,
  parseIsolateResponse,
  type IsolateProgramExport,
  type IsolateRequest,
  type IsolateResponse,
} from "./isolate-protocol.ts";
import {
  CONTENT_MODULE_NAME,
  GENERATED_MODULES,
  IMAGE_MODULE_NAME,
  ISOLATE_ENTRY_MODULE_NAME,
  ISOLATE_ENTRY_MODULES,
  ISOLATE_PROGRAM_MODULE_NAME,
} from "./generated/runtime-modules.ts";
import type { ExecutableProgram } from "./compiled-program.ts";

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
  /**
   * The project's binary files, keyed the same way — images today.
   *
   * Kept apart from `files` because a Worker's sources arrive as text and its
   * binaries do not. What a render does with them is read four numbers: an ESM
   * `import hero from "./hero.png"` becomes a metadata module in the bundle, and an
   * `image()` schema asks the content binding per entry. The bytes themselves never
   * enter the isolate, and a host that already knows an image's size may hand that
   * instead of the file — see `ProjectAsset` in `content-files.ts`.
   */
  assets?: ProjectAssetsView;
  loader: WorkerLoaderBinding;
  executionNamespace?: ExecutionNamespace;
  /** Observes resolved execution identity without wrapping the Loader callback. */
  executionObserver?: { onLoaderGet(key: string, programHash: string): void };
  /** Where pages live in `files`. */
  pagesDir?: string;
  /** Where the source tree starts in `files`. Defaults to the parent of `pagesDir`. */
  srcDir?: string;
  /** Where the project root starts in `files`. Defaults to the parent of `srcDir`. */
  rootDir?: string;
  /** `compatibility_date` for the render isolate. */
  compatibilityDate?: string;
  compatibilityFlags?: readonly string[];
  /**
   * Overrides the compiler bound to the bundled `astro.wasm`. Only a test outside
   * a Worker needs this — see `compileProject`.
   */
  compiler?: AstroCompiler;
  /**
   * Compiled files kept between renders, keyed by path and checked by `source ===`.
   *
   * Absent, every file the page reaches is compiled — which is what a host handed a
   * different project per request wants, since every lookup would miss. The host that
   * owns one is `createProjectHost`; see `compile-cache.ts`.
   */
  compileCache?: CompileCache;
  /** Tailwind's stylesheets, embedded by the host worker for CSS `@import`s. */
  tailwind?: TailwindStylesheets;
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
  /**
   * What `import.meta.env` is inside the isolate.
   *
   * Vite gives every module one and a Worker Loader module has none, so a page that
   * reads `import.meta.env.SITE` throws before it renders a byte. The host supplies
   * the values; a name it does not carry reads as `undefined`, which is what Bun gives
   * the other host for an unset `process.env` entry. See `env.ts`.
   */
  importMetaEnv?: Readonly<Record<string, string>>;
  /**
   * What `pletivo prepare` froze out of `astro:config:setup` — vendored npm packages,
   * frozen virtual modules, `node_modules` sources, the config fields a render reads,
   * and the injected script bodies.
   *
   * Code, not configuration: its modules go into the map, so a different integration
 * set is a different program hash and a different isolate — which is correct, it is
   * a different program. Without one, a project that imports an npm package fails at
   * the Loader, which is where every such project stood before. See `artifact.ts`.
   */
  artifact?: ProjectArtifact;
}

export interface RenderPageOptions extends ProjectOptions {
  /** URL pathname to render, e.g. `/` or `/blog/hello`. */
  pathname: string;
  /** `site` from the project config. Sets the origin of `Astro.url`. */
  site?: string;
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
   * Content address of the exact Loader program. The isolate cache key also covers
   * the namespace, platform settings, capabilities, and immutable environment.
   *
   * Not a project identity: the bundle is only what the requested page's import graph
   * reaches, so two pages sharing no module get two of these. That is the trade
   * `docs/todos/023 §10` records — a page compiles ~14 modules instead of 109, and a
   * write only cools the pages that can see it.
   */
  bundleId: string;
  /**
   * Generated files the HTML links to — today, what a `?url` import named. Each is
   * content-hashed, so a host can serve them from one map and cache them forever.
   *
   * The page's CSS is not among them: it is inlined, see `project-css.ts`.
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
export function typescriptSuspects(
  modules: Record<string, string>,
  /** Names the artifact supplied — Bun's own bundler output, for the same reason. */
  vendored: ReadonlySet<string> = new Set(),
): string[] {
  return Object.keys(modules)
    .filter((name) => !(name in GENERATED_MODULES) && !vendored.has(name))
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
const DEFAULT_COMPATIBILITY_FLAGS = ["nodejs_compat"];
const WORKER_HOST_ABI = "pletivo-workers-v2";
const SHARED_NAMESPACE: ExecutionNamespace = {
  tenant: "pletivo-workers-stateless",
  capabilityGeneration: "none",
};

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
 * Static executable routes enter the isolate too, so unsupported SSR exports fail
 * during enumeration instead of producing a path the host cannot later render.
 */
export async function projectPaths(options: ProjectOptions): Promise<RoutePath[]> {
  const pagesDir = options.pagesDir ?? DEFAULT_PAGES_DIR;
  const prefix = pagesDir.endsWith("/") ? pagesDir : `${pagesDir}/`;
  const routes = projectRoutes(options.files, pagesDir).filter((route) => !route.isEndpoint);
  const executable = routes.filter((route) => isExecutableModule(prefix + route.file));

  const paramSets = executable.length === 0 ? new Map<string, RouteParams[]>() :
    await isolatePaths(executable, prefix, options);

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
  const project = await compileProject({
    files: options.files,
    // Static routes are included so the isolate can reject unsupported SSR exports.
    entries: routes.map((route) => prefix + route.file),
    srcDir: srcDirOf(options),
    compiler: options.compiler,
    artifact: options.artifact,
    assets: options.assets,
    cache: options.compileCache,
    tailwind: options.tailwind,
  });
  const { payload } = await callIsolate({
    project,
    options,
    label: "resolving getStaticPaths",
    body: {
      protocol: ISOLATE_PROTOCOL_VERSION,
      op: "paths",
      routes: routes.map((route) => ({ file: prefix + route.file, route })),
    },
  });
  if (payload.status !== "paths") {
    throw new Error("[pletivo-workers] the isolate returned an unexpected getStaticPaths payload");
  }
  return new Map(
    Object.entries(payload.paths).map(([file, sets]) => [file, sets.map(decodeParams)]),
  );
}

// ── Rendering ───────────────────────────────────────────────────────

export async function renderPage(options: RenderPageOptions): Promise<RenderedPage> {
  const artifact = options.artifact?.prepared.artifact;
  const { files, pathname, loader, pagesDir = DEFAULT_PAGES_DIR } = options;
  const prefix = pagesDir.endsWith("/") ? pagesDir : `${pagesDir}/`;
  // The caller's `site` outranks the artifact's: a preview server serving one project
  // under several hostnames is naming the origin it is actually being reached at.
  const site = options.site ?? artifact?.config.site;
  const scripts = artifact?.scripts;
  const srcDir = options.srcDir ?? parentDir(pagesDir);
  const rootDir = options.rootDir ?? parentDir(srcDir);

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
    const html = await renderMarkdownPage(source);
    // No `compileProject` here any more: it ran only to feed the project-wide sheet,
    // and a `.md` page has no JavaScript graph, so its CSS is the source tree and
    // nothing else — a key scan, not a walk. That takes the wasm compiler out of every
    // markdown render. `files` rather than a merged map for the same reason: with no
    // graph, an artifact's `node_modules` sources have nothing to contribute.
    const stylesheet = await pageStylesheet({
      files,
      srcDir,
      rootDir,
      styleGraph: EMPTY_STYLE_GRAPH,
      entry: projectModuleId(file),
      html,
      scripts,
      tailwind: options.tailwind,
    });
    return {
      html: finalizeHtml(html, [stylesheet ?? ""], scripts),
      file,
      bundleId: "",
      assets: [],
    };
  }
  if (!isExecutableModule(file)) {
    throw new UnsupportedRouteError(file, "only .astro, .tsx and .md pages render here");
  }

  const project = await compileProject({
    files,
    // Just this page: everything it can execute is in its own import graph, this one
    // included — `getStaticPaths` is an export of the page module. See docs/todos/023 §4.
    entries: [file],
    srcDir,
    compiler: options.compiler,
    artifact: options.artifact,
    assets: options.assets,
    cache: options.compileCache,
    tailwind: options.tailwind,
  });
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
    entry: projectModuleId(file),
    graph: project.styleGraph,
    html: rendered.html,
    renderedModules: new Set(rendered.renderedModules),
  });
  // A `.tsx` `<style>` is page-global and is hoisted by the JSX runtime rather than
  // scoped by the compiler, so it goes after the component CSS — where `writeHtml`
  // puts it on the Bun host.
  const styles = [css, rendered.tsxStyles.join("\n")].filter(Boolean).join("\n");
  // After the render, because the page's own HTML is what Tailwind's content is. The
  // scoped blocks above are deliberately not in it — `finalizeHtml` injects them next.
  const stylesheet = await pageStylesheet({
    // `project.sources`, not `options.files`: a stylesheet imported by an `.astro`
    // component that lives in `node_modules` is only in the map the artifact merged.
    files: project.sources,
    srcDir,
    rootDir,
    styleGraph: project.styleGraph,
    entry: projectModuleId(file),
    html: rendered.html,
    scripts,
    tailwind: options.tailwind,
  });
  return {
    html: finalizeHtml(rendered.html, [stylesheet ?? "", styles], scripts),
    file,
    bundleId: rendered.bundleId,
    assets: assetsOf(project.urlAssets),
  };
}

const EMPTY_STYLE_GRAPH = { modules: [], executionEdges: [], styleEdges: [], styles: [] };

function assetsOf(urlAssets: ReadonlyMap<string, string>): RenderedAsset[] {
  const assets: RenderedAsset[] = [];
  for (const [path, body] of urlAssets) {
    assets.push({ path, contentType: urlAssetContentType(path), body });
  }
  return assets;
}

/**
 * What a `?url`-emitted file is served as.
 *
 * Only the handful of text types a project imports this way; anything else is an
 * octet stream rather than a guess, because a wrong `content-type` on a script is a
 * page that silently does not run.
 */
function urlAssetContentType(path: string): string {
  const dot = path.lastIndexOf(".");
  const extension = dot === -1 ? "" : path.slice(dot).toLowerCase();
  const known: Record<string, string> = {
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8",
    ".xml": "application/xml; charset=utf-8",
  };
  return known[extension] ?? "application/octet-stream";
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

interface IsolateRender {
  status: "rendered";
  html: string;
  renderedModules: string[];
  tsxStyles: string[];
  bundleId: string;
}

export class IsolateExecutionError extends Error {
  constructor(readonly detail: string, readonly isolateStack?: string) {
    super(`[pletivo-workers] render isolate execution failed: ${detail}`);
    this.name = "IsolateExecutionError";
  }
}

/**
 * One round trip to the render isolate, whichever question is being asked.
 *
 * The module map is the page's import graph and nothing else, so it stays
 * content-addressed — every per-request value rides in the request body, and one warm
 * isolate keeps serving however many pathnames are rendered from the same modules.
 */
async function callIsolate(input: {
  project: CompiledProject;
  options: ProjectOptions;
  /** Names the operation in an error, e.g. `rendering src/pages/index.astro`. */
  label: string;
  body: IsolateRequest;
}): Promise<{ bundleId: string; payload: IsolateResponse }> {
  const { project, options, label, body } = input;
  // The env values are not in the map — only the names their modules export, which is
  // forced: ESM decides its exports statically. Rotating a secret leaves the bundle,
  // and therefore the warm isolate, exactly where it was.
  const env = project.env === null ? null : envPayload(options.env);
  // Only for a project that reads it: an isolate that never had `import.meta.env`
  // rewritten keeps the bundle, and therefore the warm isolate, it always had.
  const importMetaEnv = project.importMetaEnv ? importMetaEnvPayload(options.importMetaEnv) : null;
  assertEnvFits(env, importMetaEnv);
  const modules = {
    ...project.program.modules,
    ...(project.env === null ? {} : envModules(project.env, env)),
    ...ISOLATE_ENTRY_MODULES,
    [ISOLATE_PROGRAM_MODULE_NAME]: programModule(project.program),
  };
  const bundleId = await programHash({ mainModule: ISOLATE_ENTRY_MODULE_NAME, modules });

  const content = project.content === null ? null : options.content;
  if (project.content !== null && !content) throw new ContentUnavailableError();
  const stateful = content !== null || outboundKind(options.outbound) === "proxy";
  if (stateful && options.executionNamespace === undefined) {
    throw new ExecutionIdentityError(
      "isolate.namespace",
      "content and proxy outbound capabilities require executionNamespace",
    );
  }
  const namespace = options.executionNamespace ?? SHARED_NAMESPACE;
  const compatibilityDate = options.compatibilityDate ?? DEFAULT_COMPATIBILITY_DATE;
  const compatibilityFlags = options.compatibilityFlags ?? DEFAULT_COMPATIBILITY_FLAGS;
  const key = await isolateKey({
    programHash: bundleId,
    namespace,
    platform: { hostAbi: WORKER_HOST_ABI, compatibilityDate, compatibilityFlags },
    policy: { outbound: outboundKind(options.outbound), env, importMetaEnv },
  });

  const isolateEnv = {
    ...(content ? { [CONTENT_BINDING]: content.binding } : {}),
    ...(env ? { [ENV_BINDING]: env } : {}),
    ...(importMetaEnv ? { [IMPORT_META_ENV_BINDING]: importMetaEnv } : {}),
  };

  const workerCode: DynamicWorkerCode = {
    compatibilityDate,
    compatibilityFlags: [...compatibilityFlags],
    mainModule: ISOLATE_ENTRY_MODULE_NAME,
    modules,
    // Cut off unless the caller said otherwise, because a render is a pure function
    // of its sources and this is code the host generated a millisecond ago. The
    // bindings below are unaffected either way: a capability is not the network.
    ...outboundConfig(options.outbound),
    ...(Object.keys(isolateEnv).length > 0 ? { env: isolateEnv } : {}),
  };
  options.executionObserver?.onLoaderGet(key, bundleId);
  // Loader serializes the callback closure. Keep the request options and host-owned
  // stores out of it; only this immutable, capability-safe DTO may cross.
  const stub = options.loader.get(key, immutableCodeFactory(workerCode));

  // Opened per render, not per isolate: the isolate outlives the request that made
  // it, so the sources have to be named by something that travels with the request.
  const handle = content ? content.store.open(options.files, options.assets) : null;
  const requestBody: IsolateRequest = handle
    ? { ...body, contentRef: handle.ref, rootDir: projectRoot(options) }
    : body;
  const request = new Request("http://pletivo.invalid/render", {
    method: "POST",
    body: JSON.stringify(requestBody),
  });
  let response: Response;
  try {
    response = await stub.getEntrypoint().fetch(request);
  } catch (error) {
    throw new IsolateStartError(error, typescriptSuspects(modules, options.artifact?.moduleNames));
  } finally {
    handle?.close();
  }
  if (!response.ok) throw new IsolateExecutionError(`${label} failed: ${await response.text()}`);
  let responseValue: unknown;
  try {
    responseValue = await response.json();
  } catch (error) {
    throw new IsolateProtocolError(
      "$",
      `expected a JSON response: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const payload = parseIsolateResponse(responseValue);
  if (payload.status === "error") throw new IsolateExecutionError(payload.message, payload.stack);
  return { bundleId, payload };
}

/** Create the Loader callback outside request-owned call frames. */
function immutableCodeFactory(code: DynamicWorkerCode): () => DynamicWorkerCode {
  return () => code;
}

/** Where the source tree sits in `files`. `compileProject` probes it for the content config. */
function srcDirOf(options: ProjectOptions): string {
  return options.srcDir ?? parentDir(options.pagesDir ?? DEFAULT_PAGES_DIR);
}

/** Where the project root sits in `files`, which is what a collection base resolves against. */
function projectRoot(options: ProjectOptions): string {
  return options.rootDir ?? parentDir(srcDirOf(options));
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
      protocol: ISOLATE_PROTOCOL_VERSION,
      op: "render",
      file,
      params: encodeParams(params),
      route,
      url: pageUrl(options.pathname, origin),
      site,
    },
  });
  if (payload.status === "unresolved") {
    throw new RoutePathNotFoundError(options.pathname, file, payload.reason);
  }
  if (payload.status !== "rendered") {
    throw new Error(`[pletivo-workers] the render isolate returned an unexpected payload`);
  }
  return { ...payload, bundleId };
}

function pageUrl(pathname: string, origin: string): string {
  return new URL("/" + pathname.replace(/^\//, ""), origin).href;
}

/**
 * The per-program half of the isolate entry, as data; `IsolateProgram` in
 * `isolate-entry.ts` is its contract. Sorted, because this text is in the Loader
 * program. An optional module is imported only when the program reaches it, so it
 * stays out of the bundle otherwise.
 */
function programModule(program: ExecutableProgram): string {
  const { content, env, importMetaEnv } = program.requirements;
  const imports: string[] = [];
  const pages = [...program.entries]
    .sort((left, right) => left.moduleId < right.moduleId ? -1 : left.moduleId > right.moduleId ? 1 : 0)
    .map(({ moduleId, executionName }) => {
      const file = moduleId.startsWith("project:") ? moduleId.slice("project:".length) : moduleId;
      return `  ${JSON.stringify(file)}: () => import(${moduleSpecifier(executionName)}),`;
    });

  let contentModules = "null";
  let contentConfig = "null";
  if (content !== null) {
    imports.push(
      `import * as $$collections from ${moduleSpecifier(CONTENT_MODULE_NAME)};`,
      `import * as $$images from ${moduleSpecifier(IMAGE_MODULE_NAME)};`,
    );
    contentModules = "{ collections: $$collections, images: $$images }";
    if (content.configExecutionName !== null) {
      contentConfig = `() => import(${moduleSpecifier(content.configExecutionName)})`;
    }
  }

  const installers: string[] = [];
  const useEnv = (names: string[] | null, local: string, module: string): void => {
    if (names === null) return;
    imports.push(`import * as ${local} from ${moduleSpecifier(module)};`);
    installers.push(`${local}.${ENV_INSTALL}`);
  };
  useEnv(env?.client ?? null, "$$envClient", ENV_CLIENT_MODULE_NAME);
  useEnv(env?.server ?? null, "$$envServer", ENV_SERVER_MODULE_NAME);

  // Keyed by the protocol's export names, which `IsolateProgram` is checked against.
  const exports: Record<IsolateProgramExport, string> = {
    pages: `{\n${pages.join("\n")}\n}`,
    contentConfig,
    content: contentModules,
    envInstallers: `[${installers.join(", ")}]`,
    importMetaEnv: String(importMetaEnv),
  };
  return [
    ...imports,
    ...Object.entries(exports).map(([name, value]) => `export const ${name} = ${value};`),
    "",
  ].join("\n");
}

function moduleSpecifier(name: string): string {
  return JSON.stringify(`./${name}`);
}
