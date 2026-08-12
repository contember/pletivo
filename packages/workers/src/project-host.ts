/**
 * One project, served over HTTP — as an object you hold, not a class you extend.
 *
 * Every host of this package had to write the same twenty lines: look in the generated
 * assets, then the images, then render, then turn the throws into status codes. The
 * preview server in `example/` did, and a Durable Object holding a live workspace would
 * have again. So it lives here once, and a host composes it:
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
 *
 * The DO owns the storage and the bindings — the two things only it can have — and
 * nothing else. That is the shape `@roj-ai/computer-platform` uses for the same reason:
 * a subclass cannot be handed to a second host, and everything interesting here has to
 * be testable without a Durable Object under it.
 */

import { parsePreparedSite, type PreparedSite } from "@pletivo/core/artifact";
import type { AstroCompiler } from "./astro-compiler.ts";
import { createCompileCache, type CompileCache } from "./compile-cache.ts";
import type { ProjectEnv } from "./env.ts";
import { serveImage } from "./images.ts";
import type { OutboundAccess } from "./outbound.ts";
import type { ProjectSnapshot, ProjectStore } from "./project-store.ts";
import {
  RouteNotFoundError,
  UnsupportedRouteError,
  projectPaths,
  renderPage,
  type ContentAccess,
  type ProjectOptions,
  type RenderedAsset,
  type RenderedPage,
  type RoutePath,
  type WorkerLoaderBinding,
} from "./render.ts";
import type { TailwindStylesheets } from "./tailwind.ts";

export interface ProjectHostOptions {
  /** Where the project is read from. See `project-store.ts`. */
  store: ProjectStore;
  loader: WorkerLoaderBinding;
  /**
   * Required only for a project with content collections, and only the host can build
   * it: the binding half needs `ctx.exports`, which nothing but the app object has.
   */
  content?: ContentAccess;
  /** Tailwind's own stylesheets, which the isolate cannot read off disk. */
  tailwind?: TailwindStylesheets;
  /** What `astro:env` answers inside the isolate. The host's configuration, not the project's. */
  env?: ProjectEnv;
  /** What `import.meta.env` is inside the isolate. */
  importMetaEnv?: Readonly<Record<string, string>>;
  /** What a rendering page's `fetch()` may reach. Omitted, it reaches nothing. */
  outbound?: OutboundAccess;
  /** Origin of `Astro.url`. Outranks the artifact's `site`. */
  site?: string;
  pagesDir?: string;
  srcDir?: string;
  rootDir?: string;
  /** `compatibility_date` for the render isolate. */
  compatibilityDate?: string;
  /** Only a test outside a Worker needs this — see `compileProject`. */
  compiler?: AstroCompiler;
  /**
   * Compiled files kept between renders.
   *
   * Absent, a default cache. `false` for a host handed a different project per request:
   * every lookup would miss and the entries would be pure heap. See `compile-cache.ts`.
   */
  compileCache?: CompileCache | false;
  /**
   * `pletivo prepare`'s output as a file *in the project*, re-read whenever the store's
   * revision moves.
   *
   * This is the workspace shape: the artifact is a file an agent's `bun install` can
   * invalidate, not a constant the host was deployed with. A host holding one in memory
   * passes `artifact` instead; a host doing neither serves a project with no npm
   * dependencies, which is where every project stood before the artifact existed.
   */
  artifactPath?: string;
  /** The artifact already parsed, for a host that is handed one per request. */
  artifact?: PreparedSite;
  /**
   * How many generated files to keep for the browser's follow-up GET.
   *
   * They are content-hashed, so an entry is never stale and the only question is how
   * many to hold. A single-project host wants a handful — one stylesheet, plus whatever
   * `?url` imports its pages make.
   */
  assetLimit?: number;
}

export interface ProjectHost {
  /**
   * Serve one request: a generated asset, an image, or a rendered page.
   *
   * Throws nothing — a route that does not exist is a 404 and a broken project is a 500
   * with the stack in the body, because the alternative is every host writing the same
   * `catch`. Call `render()` instead to handle the failures yourself.
   */
  fetch(request: Request): Promise<Response>;
  /** Render one pathname, failures and all. */
  render(pathname: string): Promise<RenderedPage>;
  /** Every page the project can enumerate. */
  paths(): Promise<RoutePath[]>;
  /** The project as the next render will see it. */
  snapshot(): Promise<ProjectSnapshot>;
}

const DEFAULT_ASSET_LIMIT = 32;

/** Content-hashed names, so nothing served under one can go stale. */
const IMMUTABLE = "public, max-age=31536000, immutable";

export function createProjectHost(options: ProjectHostOptions): ProjectHost {
  const assetLimit = options.assetLimit ?? DEFAULT_ASSET_LIMIT;
  /** What the last renders linked to, so the follow-up GET for one finds bytes. */
  const served = new Map<string, RenderedAsset>();
  /**
   * Compiled files, held for as long as this host is — not a module global: two hosts
   * in one isolate are two projects competing for one budget, and an entry's `.astro`
   * output is bound to the compiler that produced it.
   */
  const compileCache =
    options.compileCache === false ? undefined : (options.compileCache ?? createCompileCache());
  /** The parsed artifact and the revision it was read at; `null` means read and absent. */
  let artifactAt: { revision: string; artifact: PreparedSite | null } | null = null;

  /** The artifact for this snapshot: the caller's, or the project's own file. */
  function artifactOf(snapshot: ProjectSnapshot): PreparedSite | undefined {
    if (options.artifact) return options.artifact;
    const path = options.artifactPath;
    if (path === undefined) return undefined;
    if (artifactAt?.revision === snapshot.revision) return artifactAt.artifact ?? undefined;
    const source = snapshot.files.get(path);
    const artifact = source === undefined ? null : parseArtifact(source);
    artifactAt = { revision: snapshot.revision, artifact };
    return artifact ?? undefined;
  }

  /** Everything both entrypoints need, resolved against the store as it is now. */
  async function projectOptions(): Promise<ProjectOptions> {
    const snapshot = await options.store.snapshot();
    return {
      files: snapshot.files,
      assets: snapshot.assets,
      loader: options.loader,
      content: options.content,
      env: options.env,
      importMetaEnv: options.importMetaEnv,
      outbound: options.outbound,
      pagesDir: options.pagesDir,
      srcDir: options.srcDir,
      rootDir: options.rootDir,
      compatibilityDate: options.compatibilityDate,
      compiler: options.compiler,
      compileCache,
      artifact: artifactOf(snapshot),
    };
  }

  async function render(pathname: string): Promise<RenderedPage> {
    const page = await renderPage({
      ...(await projectOptions()),
      pathname,
      site: options.site,
      tailwind: options.tailwind,
    });
    if (served.size >= assetLimit) served.clear();
    for (const asset of page.assets) served.set(asset.path, asset);
    return page;
  }

  return {
    render,

    async paths(): Promise<RoutePath[]> {
      return projectPaths(await projectOptions());
    },

    snapshot: () => options.store.snapshot(),

    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);

      const asset = served.get(url.pathname);
      if (asset) {
        return new Response(asset.body, {
          headers: { "content-type": asset.contentType, "cache-control": IMMUTABLE },
        });
      }

      // `/_astro/<name>.<hash>.<ext>` and the `/cdn-cgi/image/` form a page links to.
      const { assets } = await options.store.snapshot();
      const image = serveImage(url.pathname, assets);
      if (image?.bytes) {
        return new Response(image.bytes, {
          headers: { "content-type": image.contentType, "cache-control": IMMUTABLE },
        });
      }

      try {
        const page = await render(url.pathname);
        return new Response(page.html, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "x-pletivo-page": page.file,
            "x-pletivo-bundle": page.bundleId,
          },
        });
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

/**
 * A malformed artifact is dropped rather than half-read: the render proceeds without
 * one, and the bare specifier it would have answered fails by name at the Loader —
 * a better failure than a project silently missing half its `node_modules`.
 */
function parseArtifact(source: string): PreparedSite | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }
  return parsePreparedSite(parsed);
}

function errorResponse(error: unknown): Response {
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
