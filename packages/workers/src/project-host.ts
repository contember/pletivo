/**
 * One project, served over HTTP — an object a host composes, not a class it extends,
 * so it stays testable without a Durable Object under it:
 *
 * ```ts
 * export class ProjectDO extends DurableObject<Env> {
 *   readonly #host: ProjectHost;
 *   constructor(ctx: DurableObjectState, env: Env) {
 *     super(ctx, env);
 *     this.#host = createProjectHost({ store, loader: env.LOADER, content });
 *   }
 *   fetch(request: Request): Promise<Response> {
 *     return this.#host.fetch(request);
 *   }
 * }
 * ```
 */

import {
  ArtifactFormatError,
  ArtifactVersionError,
  WORKSPACE_INPUT_PREFIX,
  digestArtifactInput,
  type ArtifactInput,
} from "@pletivo/core/artifact";
import { findWorkspaceRoot, type InputFileReader } from "@pletivo/core/prepare-inputs";
import { loadProjectArtifact, type ProjectArtifact } from "./artifact.ts";
import { browserModule, BrowserModuleError, isBrowserModulePath } from "./browser-modules.ts";
import { detectProjectFeatures, type ProjectFeatures } from "./project-features.ts";
import { publicFileResponse } from "./public-files.ts";
import { RouteRedirect, routeRedirect } from "./routing.ts";
import { createCompileCache, type CompileCache } from "./compile-cache.ts";
import { GeneratedAssetCache } from "./asset-cache.ts";
import type { GeneratedAssetStore } from "./generated-asset-store.ts";
import {
  WorkspaceSnapshotChangedError,
  type ProjectSnapshot,
  type ProjectStore,
} from "./project-store.ts";
import { findRoute, type Route } from "@pletivo/core/router";
import type { IsolateLogs } from "./isolate-protocol.ts";
import {
  IsolateExecutionError,
  RouteNotFoundError,
  UnsupportedRouteError,
  projectPaths,
  projectRoot,
  projectRoutes,
  renderPage,
  type ProjectOptions,
  type RenderedAsset,
  type RenderedPage,
  type RoutePath,
} from "./render.ts";

/** What `renderPage` takes, except what the host derives from its store and options. */
export interface ProjectHostOptions
  extends Omit<ProjectOptions, "files" | "assets" | "compileCache" | "artifact"> {
  /** Where the project is read from. See `project-store.ts`. */
  store: ProjectStore;
  /** Origin of `Astro.url`. Outranks the artifact's `site`. */
  site?: string;
  /**
   * Compiled files kept between renders. Absent, a default cache; `false` for a host
   * handed a different project per request, where every lookup would miss.
   */
  compileCache?: CompileCache | false;
  /**
   * `pletivo prepare`'s output as a file *in the project*, loaded again whenever its
   * content changes. Its prepare inputs are checked for staleness.
   */
  artifactPath?: string;
  /** `pletivo prepare`'s output as a value, validated once when the host is created. */
  artifact?: unknown;
  /** How many generated (content-hashed) files to keep in memory for the browser's follow-up GET. */
  generatedAssetCache?: { maxEntries: number; maxBytes: number };
  /**
   * Durable storage for generated files, written before a page's HTML is returned and
   * read when the in-memory cache misses. Without it, a file the cache cannot retain
   * fails the page (`GeneratedAssetRetentionError`).
   */
  generatedAssetStore?: GeneratedAssetStore;
  /**
   * Called once per page `fetch` rendered or failed to render, with what the page's code
   * logged in the isolate. For a host's diagnostics; it must not throw.
   */
  onRender?: (event: RenderEvent) => void;
}

/** One page render `fetch` served, for diagnostics. */
export interface RenderEvent {
  pathname: string;
  /** The page file, when a route matched and rendered. */
  file?: string;
  logs: IsolateLogs;
  /** Why the render failed; absent on success. */
  error?: unknown;
}

export interface ProjectHost {
  /**
   * Serve one request, first match wins: a generated asset, a processed script and what
   * it imports, a `public/` file, an image output, then a rendered page. Throws nothing:
   * failures become status codes. Call `render()` to handle them yourself.
   */
  fetch(request: Request): Promise<Response>;
  /** Render one pathname, failures and all. */
  render(pathname: string): Promise<RenderedPage>;
  /** Every page the project can enumerate. */
  paths(): Promise<RoutePath[]>;
  /** The project as the next render will see it. */
  snapshot(): Promise<ProjectSnapshot>;
  /** What the project uses that this host does not render; see `project-features.ts`. */
  features(): Promise<ProjectFeatures>;
}

const DEFAULT_GENERATED_ASSET_CACHE = { maxEntries: 32, maxBytes: 4 * 1024 * 1024 };

/** The route Astro renders for an unmatched URL: `src/pages/404.*`. */
const NOT_FOUND_PATHNAME = "/404";

function isNotFoundRoute(route: Route): boolean {
  return !route.isDynamic && !route.isEndpoint && route.segments.length === 1 && route.segments[0]?.value === "404";
}

/** Where `?url` imports are emitted; see `urlAssetHref` in compile/resolve.ts. */
const GENERATED_ASSET_PREFIX = "/_astro/";

/** Content-hashed names, so nothing served under one can go stale. */
const IMMUTABLE = "public, max-age=31536000, immutable";

export function createProjectHost(options: ProjectHostOptions): ProjectHost {
  const {
    store,
    site,
    compileCache: compileCacheOption,
    artifactPath,
    artifact: artifactValue,
    generatedAssetCache,
    generatedAssetStore,
    onRender,
    ...renderOptions
  } = options;
  const directArtifact =
    artifactValue === undefined ? undefined : loadProjectArtifact(artifactValue);
  const served = new GeneratedAssetCache(generatedAssetCache ?? DEFAULT_GENERATED_ASSET_CACHE);
  // Per host, not a module global: an entry's `.astro` output is bound to its compiler.
  const compileCache =
    compileCacheOption === false ? undefined : (compileCacheOption ?? createCompileCache());
  let artifactFrom: { source: string; artifact: ProjectArtifact } | null = null;
  let staleFrom: { artifact: ProjectArtifact; revision: string; stale: string[] } | null = null;

  /** The artifact for this snapshot: the caller's, or the project's own file. */
  function artifactOf(snapshot: ProjectSnapshot): ProjectArtifact | undefined {
    if (directArtifact !== undefined) return directArtifact;
    const path = artifactPath;
    if (path === undefined) return undefined;
    const source = snapshot.files.get(path);
    if (source === undefined) throw new ProjectArtifactError(path, "configured artifact is missing");
    if (artifactFrom?.source === source) return artifactFrom.artifact;
    const artifact = parseArtifact(source, path);
    artifactFrom = { source, artifact };
    return artifact;
  }

  /**
   * The `artifactPath` artifact's prepare inputs that no longer match the workspace.
   * A warning, so a failed check is no warning; only a moved workspace propagates.
   */
  async function staleArtifactInputs(
    snapshot: ProjectSnapshot,
    artifact: ProjectArtifact | undefined,
  ): Promise<string[]> {
    if (artifactPath === undefined || artifact === undefined) return [];
    if (staleFrom?.artifact === artifact && staleFrom.revision === snapshot.revision) {
      return staleFrom.stale;
    }
    let stale: string[];
    try {
      stale = await changedInputs(artifact.prepared.inputs ?? [], snapshot, projectRoot(renderOptions));
    } catch (error) {
      if (error instanceof WorkspaceSnapshotChangedError) throw error;
      return [];
    }
    staleFrom = { artifact, revision: snapshot.revision, stale };
    return stale;
  }

  /**
   * Run `operation` on a fresh snapshot, and once more if the workspace moved under it.
   * Not `blockConcurrencyWhile`: the content binding re-enters the Durable Object.
   */
  async function withSnapshot<T>(operation: (snapshot: ProjectSnapshot) => Promise<T>): Promise<T> {
    try {
      return await operation(await store.snapshot());
    } catch (error) {
      if (!(error instanceof WorkspaceSnapshotChangedError)) throw error;
      return operation(await store.snapshot());
    }
  }

  /** Everything both entrypoints need, resolved against the store as it is now. */
  function projectOptions(snapshot: ProjectSnapshot): ProjectOptions {
    return {
      ...renderOptions,
      files: snapshot.files,
      assets: snapshot.assets,
      compileCache,
      artifact: artifactOf(snapshot),
    };
  }

  async function renderSnapshot(
    pathname: string,
    snapshot: ProjectSnapshot,
    search?: string,
  ): Promise<RenderedPage> {
    const project = projectOptions(snapshot);
    const stale = await staleArtifactInputs(snapshot, project.artifact);
    const page = await renderPage({ ...project, pathname, search, site });
    if (generatedAssetStore !== undefined && page.assets.length > 0) {
      await generatedAssetStore.put(page.assets);
    }
    const rejected = served.putAll(page.assets);
    if (rejected.length > 0 && generatedAssetStore === undefined) {
      throw new GeneratedAssetRetentionError(rejected.map((asset) => asset.path));
    }
    return { ...page, staleArtifactInputs: stale };
  }

  /** `renderSnapshot`, reported to `onRender` whether it renders or fails. */
  async function renderReported(pathname: string, snapshot: ProjectSnapshot, search: string): Promise<RenderedPage> {
    let page: RenderedPage;
    try {
      page = await renderSnapshot(pathname, snapshot, search);
    } catch (error) {
      // A moved workspace is retried by `withSnapshot`; the retry reports.
      if (!(error instanceof WorkspaceSnapshotChangedError)) {
        const logs = error instanceof IsolateExecutionError ? error.logs : { logs: [], droppedLogs: 0 };
        onRender?.({ pathname, logs, error });
      }
      throw error;
    }
    onRender?.({ pathname, file: page.file, logs: page.logs });
    return page;
  }

  /** The memory cache, then the durable store for a path only a generated asset can have. */
  async function generatedAsset(pathname: string): Promise<RenderedAsset | null> {
    const cached = served.get(pathname);
    if (cached !== undefined) return cached;
    if (generatedAssetStore === undefined || !pathname.startsWith(GENERATED_ASSET_PREFIX)) return null;
    const stored = await generatedAssetStore.get(pathname);
    if (stored !== null) served.putAll([stored]);
    return stored;
  }

  async function serveBrowserModule(pathname: string, snapshot: ProjectSnapshot): Promise<Response> {
    try {
      const code = await browserModule(pathname, {
        files: snapshot.files,
        artifact: artifactOf(snapshot),
        compiler: renderOptions.compiler,
        compileCache,
        annotateSourceFile: renderOptions.annotateSourceFile,
      });
      return new Response(code, {
        // Unversioned URLs name the file as it is now; a reload must see an edit.
        headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" },
      });
    } catch (error) {
      if (!(error instanceof BrowserModuleError)) throw error;
      return new Response(error.message, {
        status: error.status,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
  }

  return {
    render: (pathname) => withSnapshot((snapshot) => renderSnapshot(pathname, snapshot)),

    paths: () => withSnapshot((snapshot) => projectPaths(projectOptions(snapshot))),

    snapshot: () => store.snapshot(),

    features: () =>
      withSnapshot((snapshot) =>
        detectProjectFeatures(snapshot.files, {
          pagesDir: renderOptions.pagesDir,
          compiler: renderOptions.compiler,
        }),
      ),

    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);

      try {
        const asset = await generatedAsset(url.pathname);
        if (asset !== null) {
          return new Response(asset.body, {
            headers: { "content-type": asset.contentType, "cache-control": IMMUTABLE },
          });
        }

        return await withSnapshot(async (snapshot) => {
          if (isBrowserModulePath(url.pathname)) return serveBrowserModule(url.pathname, snapshot);

          // Before routing, as Astro's dev server does: a public file shadows a page.
          const publicFile = publicFileResponse(request, url.pathname, snapshot, projectRoot(renderOptions));
          if (publicFile !== null) return publicFile;

          // `/_astro/<name>.<hash>.<ext>` and the `/cdn-cgi/image/` form a page links to.
          const image = await snapshot.assets.resolveOutput(url.pathname);
          if (image !== null) {
            if (image.bytes === null) return new Response("Not Found", { status: 404 });
            return new Response(image.bytes, {
              headers: { "content-type": image.contentType, "cache-control": IMMUTABLE },
            });
          }

          const artifact = artifactOf(snapshot);
          const routes = projectRoutes(snapshot.files, renderOptions.pagesDir);
          const redirect = routeRedirect(url, artifact?.prepared.artifact.config, artifact?.i18n ?? null, routes);
          if (redirect !== null) return redirectResponse(redirect.location, redirect.status);

          let page: RenderedPage;
          // The 404 page answers 404 also when asked for by its own URL, as on Astro.
          const matched = findRoute(routes, url.pathname);
          let status = matched !== null && isNotFoundRoute(matched.route) ? 404 : 200;
          try {
            page = await renderReported(url.pathname, snapshot, url.search);
          } catch (error) {
            // As Astro's dev server does: an unmatched URL renders the project's 404 page.
            if (!(error instanceof RouteNotFoundError) || !routes.some(isNotFoundRoute)) throw error;
            page = await renderReported(NOT_FOUND_PATHNAME, snapshot, url.search);
            status = 404;
          }
          const headers = new Headers({
            "content-type": "text/html; charset=utf-8",
            "x-pletivo-page": page.file,
            "x-pletivo-bundle": page.bundleId,
          });
          if (page.staleArtifactInputs.length > 0) {
            headers.set("x-pletivo-artifact-stale", page.staleArtifactInputs.join(","));
          }
          return new Response(page.html, { status, headers });
        });
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

/**
 * The inputs whose bytes under `root` no longer have the digest `prepare` recorded, sorted.
 * A `workspace:` input is read from the workspace root that lists `root`, searched up to
 * the store root.
 */
async function changedInputs(
  inputs: readonly ArtifactInput[],
  snapshot: ProjectSnapshot,
  root: string,
): Promise<string[]> {
  const encoder = new TextEncoder();
  const bytesRead = new Map<string, Uint8Array | undefined>();
  function bytesAt(path: string): Uint8Array | undefined {
    if (bytesRead.has(path)) return bytesRead.get(path);
    let bytes: Uint8Array | undefined;
    if (snapshot.readBytes) {
      bytes = snapshot.readBytes(path);
    } else {
      const source = snapshot.files.get(path);
      bytes = source === undefined ? undefined : encoder.encode(source);
    }
    bytesRead.set(path, bytes);
    return bytes;
  }
  function readerAt(directory: string): InputFileReader {
    return async (file) => bytesAt(joinPath(directory, file)) ?? null;
  }

  const recordsWorkspace = inputs.some((input) => input.path.startsWith(WORKSPACE_INPUT_PREFIX));
  const workspaceRoot = recordsWorkspace ? await findWorkspaceRoot(root, readerAt) : null;
  function inputLocation(input: ArtifactInput): string | undefined {
    if (!input.path.startsWith(WORKSPACE_INPUT_PREFIX)) return joinPath(root, input.path);
    if (workspaceRoot === null) return undefined;
    return joinPath(workspaceRoot, input.path.slice(WORKSPACE_INPUT_PREFIX.length));
  }

  const stale: string[] = [];
  for (const input of inputs) {
    const location = inputLocation(input);
    const bytes = location === undefined ? undefined : bytesAt(location);
    const digest = bytes === undefined ? undefined : await digestArtifactInput(bytes);
    if (digest !== input.digest) stale.push(input.path);
  }
  return stale.sort();
}

function joinPath(directory: string, file: string): string {
  return directory === "" ? file : `${directory}/${file}`;
}

/** A rendered page references generated assets this host cannot retain for follow-up GETs. */
export class GeneratedAssetRetentionError extends Error {
  constructor(readonly paths: readonly string[]) {
    super(
      `[pletivo-workers] generated asset cache cannot retain ${paths.length} referenced ` +
        `asset(s): ${paths.map((path) => JSON.stringify(path)).join(", ")}`,
    );
    this.name = "GeneratedAssetRetentionError";
  }
}

/** A configured artifact is mandatory and must be a complete V2 envelope. */
export class ProjectArtifactError extends Error {
  constructor(readonly path: string, reason: string) {
    super(`[pletivo-workers] invalid project artifact ${JSON.stringify(path)}: ${reason}`);
    this.name = "ProjectArtifactError";
  }
}

function parseArtifact(source: string, path: string): ProjectArtifact {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new ProjectArtifactError(path, error instanceof Error ? error.message : String(error));
  }
  try {
    return loadProjectArtifact(parsed);
  } catch (error) {
    // Binding errors keep their own class: the envelope is valid, this host cannot run it.
    if (error instanceof ArtifactFormatError || error instanceof ArtifactVersionError) {
      throw new ProjectArtifactError(path, error.message);
    }
    throw error;
  }
}

function redirectResponse(location: string, status: number): Response {
  return new Response(null, { status, headers: { location } });
}

function errorResponse(error: unknown): Response {
  if (error instanceof RouteRedirect) return redirectResponse(error.location, error.status);
  if (error instanceof WorkspaceSnapshotChangedError) {
    return new Response(error.message, {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "1" },
    });
  }
  const status = error instanceof RouteNotFoundError ? 404 : 500;
  const detail =
    error instanceof RouteNotFoundError || error instanceof UnsupportedRouteError
      ? error.message
      : error instanceof Error
        ? (error.stack ?? error.message)
        : String(error);
  return new Response(detail, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
