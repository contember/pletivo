/**
 * Render one route of a virtual project to HTML inside a Cloudflare Worker.
 * `.md` renders here in the host; `.astro` / `.tsx` must execute, and workerd has no
 * `eval`, so they run in a Worker Loader isolate built from `compileProject`'s map.
 *
 * A dynamic route renders in one isolate call (import, `getStaticPaths`, match,
 * render) because its props are not serializable and cannot leave the isolate.
 * `projectPaths` returns only params, the JSON-safe half.
 */

import {
  findRoute,
  parseRoute,
  routeToOutputPath,
  type Route,
  type RouteParams,
} from "@pletivo/core/router";
import { parseMarkdown } from "@pletivo/core/content/markdown";
import type { ResolvedI18nConfig } from "@pletivo/core/i18n/config";
import { resolveFallbackRoute } from "@pletivo/core/i18n/fallback";
import { detectRouteLocale } from "@pletivo/core/i18n/route-expansion";
import { RouteRedirect } from "./routing.ts";
import { projectModuleId, type ProjectArtifact } from "./artifact.ts";
import type { ProjectFiles } from "./project-store.ts";
import type { AstroCompiler } from "./astro-compiler.ts";
import type { CompileCache } from "./compile-cache.ts";
import { compileProject, isExecutableModule, type CompiledProject } from "./compile-project.ts";
import { scriptCandidateSources } from "./browser-modules.ts";
import { markdownPageHtml } from "./markdown-page.ts";
import { finalizeHtml, pageCss } from "./page-css.ts";
import { pageStylesheet, parentDir } from "./project-css.ts";
import type { TailwindStylesheets } from "./tailwind.ts";
import type { ProjectAssetsView } from "./asset-port.ts";
import type { ContentBinding, ContentFiles, ContentHandle } from "./content-files.ts";
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
  IsolateProtocolError,
  parseIsolateReply,
  type IsolateProgramExport,
  type IsolateLogs,
  type IsolateRequest,
  type IsolateResponse,
} from "./isolate-protocol.ts";
import {
  CONTENT_MODULE_NAME,
  GENERATED_MODULES,
  I18N_MODULE_NAME,
  IMAGE_MODULE_NAME,
  ISOLATE_ENTRY_MODULE_NAME,
  ISOLATE_ENTRY_MODULES,
  ISOLATE_PROGRAM_MODULE_NAME,
} from "./generated/runtime-modules.ts";
import type { ExecutableProgram, ProgramMarkdownPlugin } from "./compiled-program.ts";

// Declared structurally rather than imported from `@cloudflare/workers-types`, so
// the package keeps working whichever typings the host app has installed.

/** What a dynamic Worker is: modules, and which one to start at. */
export interface DynamicWorkerCode {
  compatibilityDate: string;
  compatibilityFlags?: string[];
  mainModule: string;
  modules: Record<string, string>;
  /**
   * `null` cuts the isolate off from the network, a binding proxies it, and *absent*
   * inherits the host worker's own access. See `outbound.ts`.
   */
  globalOutbound?: OutboundBinding | null;
  /**
   * Bindings the isolate gets, independent of `globalOutbound`. Set once at isolate
   * creation: `get()` calls the code factory only on a cache miss, so nothing
   * per-request can ride here.
   */
  env?: Record<string, unknown>;
}

export interface DynamicWorkerStub {
  getEntrypoint(): { fetch(request: Request): Promise<Response> };
}

export interface WorkerLoaderBinding {
  get(id: string, code: () => DynamicWorkerCode | Promise<DynamicWorkerCode>): DynamicWorkerStub;
}

/**
 * How the isolate reads content files, for a project that has collections.
 * Two halves because only the app has `ctx.exports`. See `content-files.ts`.
 */
export interface ContentAccess {
  /** The loopback stub the isolate calls, e.g. `ctx.exports.PletivoContent({})`. */
  binding: ContentBinding;
  /** Where the bytes come from. A handle is opened per render and closed after it. */
  store: ContentFiles;
  /**
   * Who this render's ref belongs to, e.g. a session id. The binding's entrypoint must
   * answer through `store.forOwner(owner)`; see `ContentFiles`.
   */
  owner?: string;
}

/** What every entrypoint here needs: the project, and somewhere to run it. */
export interface ProjectOptions {
  /** The project: path (no leading slash, `/` separators) -> source text. */
  files: ProjectFiles;
  /**
   * The project's binary files (images), keyed like `files`. A render reads only
   * their metadata; the bytes never enter the isolate. See `ProjectAsset`.
   */
  assets?: ProjectAssetsView;
  loader: WorkerLoaderBinding;
  executionNamespace?: ExecutionNamespace;
  /** Where pages live in `files`. */
  pagesDir?: string;
  /** Where the source tree starts in `files`. Defaults to the parent of `pagesDir`. */
  srcDir?: string;
  /** Where the project root starts in `files`. Defaults to the parent of `srcDir`. */
  rootDir?: string;
  /** `compatibility_date` for the render isolate. */
  compatibilityDate?: string;
  compatibilityFlags?: readonly string[];
  /** Overrides the compiler bound to the bundled `astro.wasm`. For tests outside a Worker. */
  compiler?: AstroCompiler;
  /**
   * Compiled files kept between renders, keyed by path and checked by `source ===`.
   * Absent, every file the page reaches is compiled. See `compile-cache.ts`.
   */
  compileCache?: CompileCache;
  /** Tailwind's stylesheets, embedded by the host worker for CSS `@import`s. */
  tailwind?: TailwindStylesheets;
  /** Required when the project has content collections, else `ContentUnavailableError`. */
  content?: ContentAccess;
  /** What the isolate may reach over the network. Omitted, it reaches nothing. See `outbound.ts`. */
  outbound?: OutboundAccess;
  /**
   * What `astro:env/client` and `astro:env/server` export inside the isolate: the
   * host's own configuration. A missing name reads as `undefined`. Capped; see `env.ts`.
   */
  env?: ProjectEnv;
  /** What `import.meta.env` is inside the isolate. A missing name reads as `undefined`. */
  importMetaEnv?: Readonly<Record<string, string>>;
  /**
   * What `pletivo prepare` froze out of `astro:config:setup`. Its modules go into the
   * map, so they are part of the program hash. See `artifact.ts`.
   */
  artifact?: ProjectArtifact;
  /**
   * Compile `.astro` with the Astro compiler's `annotateSourceFile`, as `astro dev` does:
   * every element carries `data-astro-source-file` (the project path) and
   * `data-astro-source-loc` (`line:column`), so a visual editor can map it to source.
   */
  annotateSourceFile?: boolean;
}

export interface RenderPageOptions extends ProjectOptions {
  /** URL pathname to render, e.g. `/` or `/blog/hello`. */
  pathname: string;
  /** The request's query string, `?` included, for `Astro.url.search`. */
  search?: string;
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
   * Content address of the exact Loader program. Not a project identity: the bundle
   * holds only the requested page's import graph. See docs/todos/023 §10.
   */
  bundleId: string;
  /**
   * Generated files the HTML links to (`?url` imports), content-hashed so a host can
   * cache them forever. The page's CSS is inlined, not listed here.
   */
  assets: RenderedAsset[];
  /** The processed-script URLs (`/_pletivo/script/…`) the HTML loads, in document order. */
  scriptUrls: string[];
  /**
   * Prepare inputs of a workspace artifact that changed since `pletivo prepare`, sorted.
   * Always empty from `renderPage`; `createProjectHost` fills it.
   */
  staleArtifactInputs: string[];
  /** What the page's code wrote to `console` in the isolate, bounded. */
  logs: IsolateLogs;
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
 * A dynamic route matched the pathname and then produced no page. A 404 like any
 * `RouteNotFoundError`; `reason` lets a preview server tell the two causes apart.
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
 * Thrown rather than rendering empty collections, which would look fine and be wrong.
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
 * Catches a mis-named `.js` / `.mjs` file, which is carried into the bundle verbatim.
 */
const TYPESCRIPT_SYNTAX = [
  /^\s*(?:export\s+)?interface\s+[A-Za-z_$]/m,
  /^\s*(?:export\s+)?type\s+[A-Za-z_$][\w$]*\s*=/m,
  /^\s*(?:export\s+)?(?:declare|abstract\s+class)\b/m,
  /^\s*(?:export\s+)?(?:const\s+)?enum\s+[A-Za-z_$]/m,
];

/**
 * Modules carrying TypeScript the isolate cannot run. Pre-bundled modules are skipped:
 * they are Bun output, and vendored JavaScript can contain a line that matches anyway.
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
 * The isolate refused the module bundle before running a page. The TypeScript note
 * appears only when a module carries some, since an unresolvable specifier fails the
 * same way. A page that throws while rendering is an `IsolateExecutionError` instead.
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
/** Recent enough for `Response.json` and the modern module registry in the isolate. */
const DEFAULT_COMPATIBILITY_DATE = "2026-01-01";
const DEFAULT_COMPATIBILITY_FLAGS = ["nodejs_compat"];
/** Bumped when the isolate protocol changes, so a stale isolate is never reused. v4: warm. */
const WORKER_HOST_ABI = "pletivo-workers-v4";
const SHARED_NAMESPACE: ExecutionNamespace = {
  tenant: "pletivo-workers-stateless",
  capabilityGeneration: "none",
};

/** Extensions `parseRoute` turns into routes. */
const PAGE_EXTENSIONS = [".astro", ".md", ".mdx", ".tsx", ".jsx", ".ts", ".js"];

/**
 * The project's routes, ordered the way `scanRoutes` orders them on the Bun host:
 * static before dynamic, then by specificity.
 */
export function projectRoutes(
  files: ProjectFiles,
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
 * Every page the project can enumerate: static routes, plus one entry per param set
 * each `getStaticPaths()` returns. Params only; omits `prerender = false` routes,
 * routes that declare neither, and endpoints.
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
 * The URL a route with these params is served at. Derived from `routeToOutputPath`,
 * as `paginate` does, so this list agrees with a page's own links.
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
    annotateSourceFile: options.annotateSourceFile,
    tailwind: options.tailwind,
  });
  const { payload } = await callIsolate({
    project,
    options,
    label: "resolving getStaticPaths",
    body: {
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

export async function renderPage(options: RenderPageOptions): Promise<RenderedPage> {
  const artifact = options.artifact?.prepared.artifact;
  const { files, pathname, loader, pagesDir = DEFAULT_PAGES_DIR } = options;
  const prefix = pagesDir.endsWith("/") ? pagesDir : `${pagesDir}/`;
  // The caller's `site` outranks the artifact's: it names the origin actually reached.
  const site = options.site ?? artifact?.config.site;
  const scripts = artifact?.scripts;
  const srcDir = srcDirOf(options);
  const rootDir = projectRoot(options);

  const { match, currentLocale } = matchPage(projectRoutes(files, pagesDir), pathname, options.artifact?.i18n ?? null);
  const file = prefix + match.route.file;

  if (match.route.isEndpoint) {
    throw new UnsupportedRouteError(file, "endpoint routes are not implemented");
  }

  const source = files.get(file);
  if (source === undefined) throw new RouteNotFoundError(pathname);

  if (file.endsWith(".md")) {
    // A markdown page has no module, so a dynamic one can never declare its paths.
    if (match.route.isDynamic) {
      throw new RoutePathNotFoundError(pathname, file, "not-enumerable");
    }
    const markdown = options.artifact?.prepared.artifact.config.markdown === undefined
      ? { html: await renderMarkdownPage(source), bundleId: "", logs: NO_LOGS }
      : await isolateMarkdownPage(file, source, options);
    const { html } = markdown;
    // A `.md` page has no module graph, so its CSS needs no compile and no merged map.
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
      bundleId: markdown.bundleId,
      assets: [],
      scriptUrls: [],
      staleArtifactInputs: [],
      logs: markdown.logs,
    };
  }
  if (!isExecutableModule(file)) {
    throw new UnsupportedRouteError(file, "only .astro, .tsx and .md pages render here");
  }

  const project = await compilePage(file, options);
  const rendered = await renderModule({
    project,
    file,
    params: match.params,
    // The isolate treats a page without a route as static.
    route: match.route.isDynamic ? match.route : null,
    site,
    currentLocale,
    options,
  });
  const css = pageCss({
    entry: projectModuleId(file),
    graph: project.styleGraph,
    html: rendered.html,
    renderedModules: new Set(rendered.renderedModules),
  });
  // A `.tsx` `<style>` is page-global, so it goes after the component CSS, as on Bun.
  const styles = [css, rendered.tsxStyles.join("\n")].filter(Boolean).join("\n");
  // After the render: the page's HTML is Tailwind's content.
  const stylesheet = await pageStylesheet({
    // `project.sources`: only the artifact-merged map holds `node_modules` stylesheets.
    files: project.sources,
    srcDir,
    rootDir,
    styleGraph: project.styleGraph,
    entry: projectModuleId(file),
    html: rendered.html,
    scripts,
    browserSources: scriptCandidateSources(project.scripts, files),
    tailwind: options.tailwind,
  });
  return {
    html: finalizeHtml(rendered.html, [stylesheet ?? "", styles], scripts),
    file,
    bundleId: rendered.bundleId,
    assets: assetsOf(project.urlAssets),
    scriptUrls: loadedScriptUrls(rendered.html, project.program.scripts),
    staleArtifactInputs: [],
    logs: rendered.logs,
  };
}

/** Just this page: `getStaticPaths` is in its import graph too. See docs/todos/023 §4. */
function compilePage(file: string, options: ProjectOptions): Promise<CompiledProject> {
  return compileProject({
    files: options.files,
    entries: [file],
    srcDir: srcDirOf(options),
    compiler: options.compiler,
    artifact: options.artifact,
    assets: options.assets,
    cache: options.compileCache,
    annotateSourceFile: options.annotateSourceFile,
    tailwind: options.tailwind,
  });
}

export interface WarmPageOptions extends ProjectOptions {
  /** The URL pathname whose page to warm, as `renderPage` would be asked for it. */
  pathname: string;
}

/**
 * The cold half of `renderPage`: compile the page's module graph and import the page in
 * the isolate its render will use, rendering nothing. A `.md` page has no module to warm.
 */
export async function warmPage(options: WarmPageOptions): Promise<void> {
  const { files, pathname, pagesDir = DEFAULT_PAGES_DIR } = options;
  const prefix = pagesDir.endsWith("/") ? pagesDir : `${pagesDir}/`;
  const { match } = matchPage(projectRoutes(files, pagesDir), pathname, options.artifact?.i18n ?? null);
  const file = prefix + match.route.file;
  if (match.route.isEndpoint || !isExecutableModule(file)) return;
  const { payload } = await callIsolate({
    project: await compilePage(file, options),
    options,
    label: `warming ${file}`,
    body: { op: "warm", file },
  });
  if (payload.status !== "warmed") {
    throw new Error("[pletivo-workers] the render isolate returned an unexpected warm-up payload");
  }
}

const NO_LOGS: IsolateLogs = { logs: [], droppedLogs: 0 };

/** The program's script URLs `html` loads, as `renderScript` spells the tag, in document order. */
function loadedScriptUrls(html: string, scripts: Readonly<Record<string, string>>): string[] {
  return [...new Set(Object.values(scripts))]
    .map((url) => ({ url, at: html.indexOf(`src="${url}"`) }))
    .filter(({ at }) => at !== -1)
    .sort((left, right) => left.at - right.at)
    .map(({ url }) => url);
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
 * What a `?url`-emitted file is served as. Unknown types are an octet stream rather
 * than a guess: a wrong `content-type` on a script silently stops it running.
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

/** A `.md` page, rendered as `build.ts` renders one. No isolate involved. */
export async function renderMarkdownPage(source: string): Promise<string> {
  const { html, frontmatter } = await parseMarkdown(source);
  return markdownPageHtml(html, frontmatter);
}

/**
 * A `.md` page of a project with configured Markdown plugins. The plugins are code from
 * the artifact, so they run where project code runs: in the isolate.
 */
async function isolateMarkdownPage(
  file: string,
  source: string,
  options: RenderPageOptions,
): Promise<{ html: string; bundleId: string; logs: IsolateLogs }> {
  const project = await compileProject({
    files: options.files,
    entries: [],
    srcDir: srcDirOf(options),
    compiler: options.compiler,
    artifact: options.artifact,
    assets: options.assets,
    cache: options.compileCache,
    annotateSourceFile: options.annotateSourceFile,
    tailwind: options.tailwind,
    markdown: true,
  });
  const { bundleId, payload, logs } = await callIsolate({
    project,
    options,
    label: `rendering ${file}`,
    body: { op: "markdown", file, source },
  });
  if (payload.status !== "rendered") {
    throw new Error("[pletivo-workers] the render isolate returned an unexpected Markdown payload");
  }
  return { html: payload.html, bundleId, logs };
}

interface IsolateRender {
  status: "rendered";
  html: string;
  renderedModules: string[];
  tsxStyles: string[];
  bundleId: string;
  logs: IsolateLogs;
}

export class IsolateExecutionError extends Error {
  constructor(
    readonly detail: string,
    readonly isolateStack?: string,
    /** What the failed request logged before it failed. */
    readonly logs: IsolateLogs = { logs: [], droppedLogs: 0 },
  ) {
    super(`[pletivo-workers] render isolate execution failed: ${detail}`);
    this.name = "IsolateExecutionError";
  }
}

/**
 * One round trip to the render isolate. The module map stays content-addressed:
 * every per-request value rides in the request body.
 */
async function callIsolate(input: {
  project: CompiledProject;
  options: ProjectOptions;
  /** Names the operation in an error, e.g. `rendering src/pages/index.astro`. */
  label: string;
  body: IsolateRequest;
}): Promise<{ bundleId: string; payload: IsolateResponse; logs: IsolateLogs }> {
  const { project, options, label, body } = input;
  const { requirements } = project.program;
  // Only env names are in the map (ESM exports are static); values ride in bindings,
  // so rotating a secret keeps the bundle.
  const env = requirements.env === null ? null : envPayload(options.env);
  // Only for a project that reads it, so other bundles stay unchanged.
  const importMetaEnv = requirements.importMetaEnv ? importMetaEnvPayload(options.importMetaEnv) : null;
  assertEnvFits(env, importMetaEnv);
  const modules = {
    ...project.program.modules,
    ...(requirements.env === null ? {} : envModules(requirements.env, env)),
    ...ISOLATE_ENTRY_MODULES,
    [ISOLATE_PROGRAM_MODULE_NAME]: programModule(project.program),
  };
  const bundleId = await programHash({ mainModule: ISOLATE_ENTRY_MODULE_NAME, modules });

  const content = requirements.content === null ? null : options.content;
  if (requirements.content !== null && !content) throw new ContentUnavailableError();
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
    // Cut off unless the caller said otherwise; bindings are unaffected either way.
    ...outboundConfig(options.outbound),
    ...(Object.keys(isolateEnv).length > 0 ? { env: isolateEnv } : {}),
  };
  // Loader serializes the callback closure; only this immutable DTO may cross.
  const stub = options.loader.get(key, immutableCodeFactory(workerCode));

  // Opened per render: the isolate outlives the request, so the ref travels with it.
  const handle = content ? content.store.open(options.files, options.assets, content.owner) : null;
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
    throwContentFailure(handle);
    throw new IsolateStartError(error, typescriptSuspects(modules, options.artifact?.moduleNames));
  } finally {
    handle?.close();
  }
  // Before the response: a failed content read is the cause of whatever the isolate says.
  throwContentFailure(handle);
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
  const payload = parseIsolateReply(responseValue);
  const logs: IsolateLogs = { logs: payload.logs, droppedLogs: payload.droppedLogs };
  if (payload.status === "error") throw new IsolateExecutionError(payload.message, payload.stack, logs);
  return { bundleId, payload, logs };
}

/** Rethrow a content read's own error, which reaches the isolate only as a message. */
function throwContentFailure(handle: ContentHandle | null): void {
  const failure = handle?.failure();
  if (failure !== undefined) throw failure;
}

/** Create the Loader callback outside request-owned call frames. */
function immutableCodeFactory(code: DynamicWorkerCode): () => DynamicWorkerCode {
  return () => code;
}

type ProjectLayout = Pick<ProjectOptions, "pagesDir" | "srcDir" | "rootDir">;

/** Where the source tree sits in `files`. `compileProject` probes it for the content config. */
function srcDirOf(options: ProjectLayout): string {
  return options.srcDir ?? parentDir(options.pagesDir ?? DEFAULT_PAGES_DIR);
}

/**
 * Where the project root sits in `files`: what a collection base and an artifact's
 * prepare inputs resolve against.
 */
export function projectRoot(options: ProjectLayout): string {
  return options.rootDir ?? parentDir(srcDirOf(options));
}

async function renderModule(input: {
  project: CompiledProject;
  file: string;
  params: RouteParams;
  /** The matched route when it is dynamic, `null` when it is static. */
  route: Route | null;
  site: string | undefined;
  currentLocale: string | undefined;
  options: RenderPageOptions;
}): Promise<IsolateRender> {
  const { project, file, params, route, site, currentLocale, options } = input;

  // The origin `build.ts` gives `Astro.url`: the configured site, or a localhost stand-in.
  const origin = site ? new URL(site).origin : "http://localhost/";
  const { bundleId, payload, logs } = await callIsolate({
    project,
    options,
    label: `rendering ${file}`,
    body: {
      op: "render",
      file,
      params: encodeParams(params),
      route,
      url: pageUrl(options.pathname, options.search ?? "", origin),
      site,
      ...(currentLocale === undefined ? {} : { currentLocale }),
    },
  });
  if (payload.status === "unresolved") {
    throw new RoutePathNotFoundError(options.pathname, file, payload.reason);
  }
  if (payload.status !== "rendered") {
    throw new Error(`[pletivo-workers] the render isolate returned an unexpected payload`);
  }
  return { ...payload, bundleId, logs };
}

function pageUrl(pathname: string, search: string, origin: string): string {
  return new URL("/" + pathname.replace(/^\//, "") + search, origin).href;
}

/**
 * The route a pathname renders, and `Astro.currentLocale` for it. Under i18n, a page a
 * locale lacks renders from its fallback locale (rewrite), or redirects to it.
 */
function matchPage(
  routes: Route[],
  pathname: string,
  i18n: ResolvedI18nConfig | null,
): { match: { route: Route; params: RouteParams }; currentLocale: string | undefined } {
  const match = findRoute(routes, pathname);
  if (match !== null) {
    return { match, currentLocale: i18n === null ? undefined : detectRouteLocale(match.route, i18n).locale?.code };
  }
  const fallback = i18n === null ? null : resolveFallbackRoute(pathname, routes, i18n, "/");
  if (fallback === null) throw new RouteNotFoundError(pathname);
  if (fallback.mode === "redirect" && fallback.redirectTo !== undefined) {
    throw new RouteRedirect(fallback.redirectTo, 302);
  }
  return { match: { route: fallback.route, params: fallback.params }, currentLocale: fallback.targetLocale };
}

/**
 * The per-program half of the isolate entry; `IsolateProgram` is its contract. Sorted,
 * because this text is in the Loader program. Optional modules are imported only when reached.
 */
function programModule(program: ExecutableProgram): string {
  const { content, markdown, env, importMetaEnv } = program.requirements;
  const imports: string[] = [];
  const pages = [...program.entries]
    .sort((left, right) => left.moduleId < right.moduleId ? -1 : left.moduleId > right.moduleId ? 1 : 0)
    .map(({ moduleId, executionName }) => {
      const file = moduleId.startsWith("project:") ? moduleId.slice("project:".length) : moduleId;
      return `  ${JSON.stringify(file)}: () => import(${moduleSpecifier(executionName)}),`;
    });

  if (content !== null || markdown !== null) {
    imports.push(`import * as $$content from ${moduleSpecifier(CONTENT_MODULE_NAME)};`);
  }
  let contentModules = "null";
  let contentConfig = "null";
  if (content !== null) {
    imports.push(`import * as $$images from ${moduleSpecifier(IMAGE_MODULE_NAME)};`);
    contentModules = "{ collections: $$content, images: $$images }";
    if (content.configExecutionName !== null) {
      contentConfig = `() => import(${moduleSpecifier(content.configExecutionName)})`;
    }
  }

  let markdownPipeline = "null";
  if (markdown !== null) {
    const pluginModules = new Map<string, string>();
    const plugins = (entries: readonly ProgramMarkdownPlugin[]): string =>
      `[${entries.map((entry) => {
        let local = pluginModules.get(entry.executionName);
        if (local === undefined) {
          local = `$$markdownPlugin${pluginModules.size}`;
          pluginModules.set(entry.executionName, local);
          imports.push(`import * as ${local} from ${moduleSpecifier(entry.executionName)};`);
        }
        const options = entry.options === undefined ? "" : `, options: ${JSON.stringify(entry.options)}`;
        return `{ module: ${local}, exportName: ${JSON.stringify(entry.exportName)}${options} }`;
      }).join(", ")}]`;
    markdownPipeline = `{ module: $$content, remarkPlugins: ${plugins(markdown.remarkPlugins)}, ` +
      `rehypePlugins: ${plugins(markdown.rehypePlugins)}, ` +
      `remarkRehype: ${JSON.stringify(markdown.remarkRehype ?? null)}, gfm: ${JSON.stringify(markdown.gfm ?? null)} }`;
  }

  let i18nModule = "null";
  if (program.requirements.i18n !== null) {
    imports.push(`import * as $$i18n from ${moduleSpecifier(I18N_MODULE_NAME)};`);
    i18nModule = `{ module: $$i18n, config: ${JSON.stringify(program.requirements.i18n.config)} }`;
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
    markdown: markdownPipeline,
    scripts: JSON.stringify(program.scripts),
    i18n: i18nModule,
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
