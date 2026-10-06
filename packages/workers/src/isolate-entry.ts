/**
 * What runs inside the render isolate: request parsing, the `render` and `paths` ops,
 * and the per-request content scope. The host generates `pletivo-program.js` per
 * bundle; `pletivo-entry.js` hands its exports to `createIsolateEntry`.
 *
 * `getStaticPaths` runs only here: its props are not serializable, so `render` resolves
 * and renders in one go and `paths` returns params only.
 */

import type * as ContentCollection from "@pletivo/core/content/collection";
import type * as Images from "@pletivo/core/image";
import type { Route, RouteParams } from "@pletivo/core/router";
import { createPaginate } from "@pletivo/core/paginate";
import {
  isAstroComponent,
  redirectPageHtml,
  renderAstroPage,
  runWithRenderTracking,
  type PageContext,
} from "@pletivo/runtime/astro-shim";
import type { ContentBinding } from "./content-files.ts";
import {
  ENV_BINDING,
  IMPORT_META_ENV_BINDING,
  IMPORT_META_ENV_GLOBAL,
  type EnvPayload,
} from "./env.ts";
import {
  CONTENT_BINDING,
  decodeParams,
  encodeParams,
  type IsolateParamPair,
  type IsolatePathRoute,
  type IsolatePathsResponse,
  type IsolateRenderedResponse,
  type IsolateRenderRequest,
  type IsolateRequest,
  type IsolateUnresolvedResponse,
  type IsolateErrorResponse,
  type IsolateProgramExport,
} from "./isolate-protocol.ts";
import { normalizeProjectPath } from "./project-path.ts";
import type { UnresolvedReason } from "./render.ts";

/** A compiled page module. Every field is user code, so each is checked before use. */
export interface PageModule {
  default?: unknown;
  getStaticPaths?: unknown;
  prerender?: unknown;
}

export interface ContentConfigModule {
  collections?: Record<string, ContentCollection.CollectionConfig>;
}

export type ContentCollectionModule = Pick<
  typeof ContentCollection,
  "createContentRuntime" | "imageSchemaFor" | "initCollections" | "runWithContentRuntime"
>;

export type ImageModule = Pick<typeof Images, "imageOutputPath" | "makeImageMetadata">;

/** The modules a program that reaches for the content API carries. */
export interface ContentModules {
  collections: ContentCollectionModule;
  images: ImageModule;
}

/** An `astro:env` module's installer; the values arrive in the isolate's `env`. */
export type EnvInstaller = (values: Partial<EnvPayload>) => void;

/** The exports of the generated `pletivo-program.js`. */
export interface IsolateProgram {
  /**
   * Project path -> page module. Thunks, so rendering one route does not evaluate a
   * sibling page that throws at module scope, and so the compile walk stays pruned.
   */
  pages: Readonly<Record<string, () => Promise<PageModule>>>;
  /** `content.config.*`, behind a thunk for the same reason pages are. */
  contentConfig: (() => Promise<ContentConfigModule>) | null;
  content: ContentModules | null;
  envInstallers: readonly EnvInstaller[];
  importMetaEnv: boolean;
}

// Fails typecheck when a field is renamed here without renaming the export the host emits.
export type ProgramExportsMatch = Assert<SameKeys<keyof IsolateProgram, IsolateProgramExport>>;
type SameKeys<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;

/** The isolate's `env`, as the host's `callIsolate` builds it. */
export interface IsolateEnv {
  [CONTENT_BINDING]?: ContentBinding;
  [ENV_BINDING]?: EnvPayload;
  [IMPORT_META_ENV_BINDING]?: Record<string, string>;
}

export interface IsolateEntry {
  fetch(request: Request, env: IsolateEnv): Promise<Response>;
}

// The Workers host has no `base` yet, so paginate's URLs are root-relative.
const BASE = "/";

export function createIsolateEntry(program: IsolateProgram): IsolateEntry {
  return {
    async fetch(request, env) {
      // An error payload, not a throw: across the Loader boundary a throw looks the same
      // as a bundle that failed to start.
      try {
        const body: IsolateRequest = JSON.parse(await request.text());
        // Installed before any page is imported, since frontmatter reads it at import time.
        if (program.importMetaEnv) {
          Reflect.set(globalThis, IMPORT_META_ENV_GLOBAL, env[IMPORT_META_ENV_BINDING] ?? {});
        }
        // Module state is safe for these, unlike content: the isolate's `env` is fixed at
        // creation and covered by its id.
        for (const install of program.envInstallers) install(env[ENV_BINDING] ?? {});
        return await withContent(program, env[CONTENT_BINDING], body, () =>
          body.op === "paths" ? listPaths(program, body.routes) : render(program, body),
        );
      } catch (error) {
        const response: IsolateErrorResponse = {
          status: "error",
          message: error instanceof Error ? error.message : String(error),
          ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
        };
        return Response.json(response);
      }
    },
  };
}

function loadPage(program: IsolateProgram, file: string): Promise<PageModule> | null {
  const load = program.pages[file];
  return load ? load() : null;
}

function assertStaticOnly(module: PageModule, file: string): void {
  if (module.prerender === false) {
    throw new Error(file + " exports prerender = false, which this static Worker host rejects");
  }
}

/**
 * What a dynamic route renders with, or why it renders nothing: an enumerable route
 * renders only what `getStaticPaths()` listed, and a route that declares no path list
 * stays a 404.
 */
async function resolveDynamic(
  module: PageModule,
  route: Route,
  urlParams: RouteParams,
  file: string,
): Promise<StaticPath | UnresolvedReason> {
  const paths = await staticPaths(module, route, file);
  if (paths === null) return "not-enumerable";
  // `Astro.params` is the path's own param set, not the URL's: an entry may carry
  // params no URL segment names.
  const match = paths.find((entry) =>
    Object.keys(urlParams).every((name) => entry.params[name] === urlParams[name]),
  );
  return match ?? "no-static-path";
}

interface StaticPath {
  params: RouteParams;
  props: Record<string, unknown>;
}

/** `getStaticPaths()` output, or `null` when the module declares none. */
async function staticPaths(
  module: PageModule,
  route: Route,
  file: string,
): Promise<StaticPath[] | null> {
  const getStaticPaths = module.getStaticPaths;
  if (typeof getStaticPaths !== "function") return null;
  const result: unknown = await getStaticPaths({ paginate: createPaginate(route, BASE) });
  if (!Array.isArray(result)) {
    throw new Error(`${file}: getStaticPaths() must return an array`);
  }
  return result.map((entry: unknown, index): StaticPath => {
    if (!isRecord(entry) || !isRecord(entry.params)) {
      throw new Error(`${file}: getStaticPaths() entry ${index} has no params object`);
    }
    return {
      params: parseParams(entry.params, file),
      props: isRecord(entry.props) ? entry.props : {},
    };
  });
}

/** `null` reads as `undefined`, as it did when params crossed the boundary unchecked. */
function parseParams(raw: Record<string, unknown>, file: string): RouteParams {
  const params: RouteParams = {};
  for (const [name, value] of Object.entries(raw)) {
    if (value === null || value === undefined) {
      params[name] = undefined;
    } else if (typeof value === "string") {
      params[name] = value;
    } else {
      throw new Error(`${file}: getStaticPaths() param ${JSON.stringify(name)} must be a string`);
    }
  }
  return params;
}

async function renderPageComponent(
  component: unknown,
  props: Record<string, unknown>,
  pageContext: PageContext,
): Promise<string> {
  // A compiled `.astro` default export takes `(result, props, slots)` and a `.tsx`
  // one takes plain props — the same split `build.ts` makes.
  if (isAstroComponent(component)) return renderAstroPage(component, props, pageContext);
  if (typeof component !== "function") return "";
  const output: unknown = await component({ ...props, __pageContext: pageContext });
  if (typeof output === "string") return output;
  // A static file cannot send a 3xx, so a redirect becomes the meta-refresh page
  // Astro's static output emits. Any other Response has no static equivalent.
  if (output instanceof Response) {
    return output.headers.get("location") ? redirectPageHtml(output) : "";
  }
  if (isRecord(output) && typeof output.__html === "string") return output.__html;
  return "";
}

async function listPaths(
  program: IsolateProgram,
  routes: readonly IsolatePathRoute[],
): Promise<Response> {
  const paths: Record<string, IsolateParamPair[][]> = {};
  for (const { file, route } of routes) {
    const module = await loadPage(program, file);
    if (!module) throw new Error("no module for " + file);
    assertStaticOnly(module, file);
    const list = await staticPaths(module, route, file);
    if (list === null) continue;
    paths[file] = list.map((entry) => encodeParams(entry.params));
  }
  const response: IsolatePathsResponse = { status: "paths", paths };
  return Response.json(response);
}

async function render(program: IsolateProgram, request: IsolateRenderRequest): Promise<Response> {
  const { file, route, url, site } = request;
  const module = await loadPage(program, file);
  if (!module) return new Response("no module for " + file, { status: 404 });
  assertStaticOnly(module, file);
  if (typeof module.default !== "function") {
    return new Response(file + " has no default export", { status: 500 });
  }
  let params = decodeParams(request.params);
  let props: Record<string, unknown> = {};
  if (route) {
    const resolved = await resolveDynamic(module, route, params, file);
    if (typeof resolved === "string") {
      const response: IsolateUnresolvedResponse = {
        status: "unresolved",
        reason: resolved,
      };
      return Response.json(response);
    }
    params = resolved.params;
    props = resolved.props;
  }
  const component = module.default;
  const { value, renderedModules, tsxStyles } = await runWithRenderTracking(() =>
    renderPageComponent(component, props, {
      url: new URL(url),
      site: site ? new URL(site) : undefined,
      params,
      preferredLocaleList: [],
    }),
  );
  const response: IsolateRenderedResponse = {
    status: "rendered",
    html: value,
    renderedModules: [...renderedModules],
    tsxStyles,
  };
  return Response.json(response);
}

/**
 * A path against a directory, as a file-map key. Normalised, not joined: a verbatim
 * `./content/x` base is a prefix no key starts with, silently emptying the collection.
 */
export function resolveFrom(dir: string, relative: string): string {
  return normalizeProjectPath(`${dir}/${relative}`);
}

function dirname(path: string): string {
  const at = path.lastIndexOf("/");
  return at === -1 ? "" : path.slice(0, at);
}

/**
 * Runs `run` inside a content runtime built for this request. Per request because the
 * isolate is reused: calls carry this request's ref, and a content edit keeps the isolate.
 */
async function withContent(
  program: IsolateProgram,
  files: ContentBinding | undefined,
  body: IsolateRequest,
  run: () => Promise<Response>,
): Promise<Response> {
  const modules = program.content;
  if (modules === null) return run();
  if (!files) throw new Error("[pletivo-workers] the render isolate has no content binding");
  const ref = body.contentRef;
  if (ref === undefined) throw new Error("[pletivo-workers] the render request carries no content ref");
  const { collections, images } = modules;
  const loadConfig = program.contentConfig;
  const runtime = collections.createContentRuntime({
    async scan(projectRoot, base, pattern) {
      const dir = resolveFrom(projectRoot, base);
      return {
        root: dir,
        // Rooted at the file map, so `generateId` sees a different prefix than on Bun.
        rootUrl: new URL("file:///" + dir + "/"),
        files: await files.scan(ref, dir, pattern),
      };
    },
    async readFile(path) {
      const text = await files.read(ref, path);
      if (text === null) throw new Error("[pletivo-workers] no content file " + path);
      return text;
    },
    dirname,
    resolveDir: resolveFrom,
    image(entryDir) {
      return collections.imageSchemaFor(entryDir, async (dir, relative) => {
        const path = resolveFrom(dir, relative);
        const info = await files.image(ref, path);
        if (!info) throw new Error("image not found: " + relative + " (resolved to " + path + ")");
        return images.makeImageMetadata({
          src: "/" + images.imageOutputPath(path, info.hash),
          width: info.width,
          height: info.height,
          format: info.format,
          fsPath: path,
        });
      });
    },
    async loadConfig() {
      if (!loadConfig) return {};
      const module = await loadConfig();
      return module.collections || {};
    },
  });
  return collections.runWithContentRuntime(runtime, async () => {
    await collections.initCollections(body.rootDir || "");
    return run();
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
