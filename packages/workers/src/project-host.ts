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

import {
  ArtifactFormatError,
  ArtifactVersionError,
  digestArtifactInput,
  type ArtifactInput,
} from "@pletivo/core/artifact";
import { loadProjectArtifact, type ProjectArtifact } from "./project-artifact.ts";
import type { AstroCompiler } from "./astro-compiler.ts";
import { createCompileCache, type CompileCache } from "./compile-cache.ts";
import { GeneratedAssetCache } from "./asset-cache.ts";
import type { ProjectEnv } from "./env.ts";
import type { ExecutionNamespace } from "./execution-identity.ts";
import type { OutboundAccess } from "./outbound.ts";
import {
  WorkspaceSnapshotChangedError,
  type ProjectSnapshot,
  type ProjectStore,
} from "./project-store.ts";
import {
  RouteNotFoundError,
  UnsupportedRouteError,
  projectPaths,
  projectRoot,
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
  compatibilityFlags?: readonly string[];
  executionNamespace?: ExecutionNamespace;
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
   * `pletivo prepare`'s output as a file *in the project*, loaded again whenever its
   * content changes.
   *
   * This is the workspace shape: the artifact is a file an agent's `bun install` can
   * invalidate, not a constant the host was deployed with. A host holding one in memory
   * passes `artifact` instead; a host doing neither serves a project with no npm
   * dependencies, which is where every project stood before the artifact existed.
   */
  artifactPath?: string;
  /** `pletivo prepare`'s output as a value, validated once when the host is created. */
  artifact?: unknown;
  /**
   * How many generated files to keep for the browser's follow-up GET.
   *
   * They are content-hashed, so an entry is never stale and the only question is how
   * many to hold. A single-project host wants a handful — one stylesheet, plus whatever
   * `?url` imports its pages make.
   */
  generatedAssetCache?: { maxEntries: number; maxBytes: number };
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

const DEFAULT_GENERATED_ASSET_CACHE = { maxEntries: 32, maxBytes: 4 * 1024 * 1024 };

/** Content-hashed names, so nothing served under one can go stale. */
const IMMUTABLE = "public, max-age=31536000, immutable";

export function createProjectHost(options: ProjectHostOptions): ProjectHost {
  const directArtifact =
    options.artifact === undefined ? undefined : loadProjectArtifact(options.artifact);
  const served = new GeneratedAssetCache<RenderedAsset>(
    options.generatedAssetCache ?? DEFAULT_GENERATED_ASSET_CACHE,
  );
  /**
   * Compiled files, held for as long as this host is — not a module global: two hosts
   * in one isolate are two projects competing for one budget, and an entry's `.astro`
   * output is bound to the compiler that produced it.
   */
  const compileCache =
    options.compileCache === false ? undefined : (options.compileCache ?? createCompileCache());
  let artifactFrom: { source: string; artifact: ProjectArtifact } | null = null;
  let staleFrom: { artifact: ProjectArtifact; revision: string; stale: string[] } | null = null;

  /** The artifact for this snapshot: the caller's, or the project's own file. */
  function artifactOf(snapshot: ProjectSnapshot): ProjectArtifact | undefined {
    if (directArtifact !== undefined) return directArtifact;
    const path = options.artifactPath;
    if (path === undefined) return undefined;
    const source = snapshot.files.get(path);
    if (source === undefined) throw new ProjectArtifactError(path, "configured artifact is missing");
    if (artifactFrom?.source === source) return artifactFrom.artifact;
    const artifact = parseArtifact(source, path);
    artifactFrom = { source, artifact };
    return artifact;
  }

  /**
   * The artifact's prepare inputs that no longer match the workspace. Only an
   * `artifactPath` artifact is checked: a direct one has no workspace to compare against.
   * A warning, so a failed check is no warning; only a moved workspace propagates, to be
   * retried with the rest of the attempt.
   */
  async function staleArtifactInputs(
    snapshot: ProjectSnapshot,
    artifact: ProjectArtifact | undefined,
  ): Promise<string[]> {
    if (options.artifactPath === undefined || artifact === undefined) return [];
    if (staleFrom?.artifact === artifact && staleFrom.revision === snapshot.revision) {
      return staleFrom.stale;
    }
    let stale: string[];
    try {
      stale = await changedInputs(artifact.prepared.inputs ?? [], snapshot, projectRoot(options));
    } catch (error) {
      if (error instanceof WorkspaceSnapshotChangedError) throw error;
      return [];
    }
    staleFrom = { artifact, revision: snapshot.revision, stale };
    return stale;
  }

  /**
   * Run `operation` on a fresh snapshot, and once more on another when the workspace moved
   * under the first. `blockConcurrencyWhile` cannot hold writes off instead: the content
   * binding re-enters the Durable Object during the render.
   */
  async function withSnapshot<T>(operation: (snapshot: ProjectSnapshot) => Promise<T>): Promise<T> {
    try {
      return await operation(await options.store.snapshot());
    } catch (error) {
      if (!(error instanceof WorkspaceSnapshotChangedError)) throw error;
      return operation(await options.store.snapshot());
    }
  }

  /** Everything both entrypoints need, resolved against the store as it is now. */
  function projectOptions(snapshot: ProjectSnapshot): ProjectOptions {
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
      compatibilityFlags: options.compatibilityFlags,
      executionNamespace: options.executionNamespace,
      compiler: options.compiler,
      compileCache,
      artifact: artifactOf(snapshot),
      tailwind: options.tailwind,
    };
  }

  async function renderSnapshot(pathname: string, snapshot: ProjectSnapshot): Promise<RenderedPage> {
    const project = projectOptions(snapshot);
    const stale = await staleArtifactInputs(snapshot, project.artifact);
    const page = await renderPage({ ...project, pathname, site: options.site });
    const rejected = served.putAll(page.assets);
    if (rejected.length > 0) {
      throw new GeneratedAssetRetentionError(rejected.map((asset) => asset.path));
    }
    return { ...page, staleArtifactInputs: stale };
  }

  return {
    render: (pathname) => withSnapshot((snapshot) => renderSnapshot(pathname, snapshot)),

    paths: () => withSnapshot((snapshot) => projectPaths(projectOptions(snapshot))),

    snapshot: () => options.store.snapshot(),

    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);

      const asset = served.get(url.pathname);
      if (asset) {
        return new Response(asset.body, {
          headers: { "content-type": asset.contentType, "cache-control": IMMUTABLE },
        });
      }

      try {
        return await withSnapshot(async (snapshot) => {
          // `/_astro/<name>.<hash>.<ext>` and the `/cdn-cgi/image/` form a page links to.
          const image = await snapshot.assets.resolveOutput(url.pathname);
          if (image !== null) {
            if (image.bytes === null) return new Response("Not Found", { status: 404 });
            return new Response(image.bytes, {
              headers: { "content-type": image.contentType, "cache-control": IMMUTABLE },
            });
          }

          const page = await renderSnapshot(url.pathname, snapshot);
          const headers = new Headers({
            "content-type": "text/html; charset=utf-8",
            "x-pletivo-page": page.file,
            "x-pletivo-bundle": page.bundleId,
          });
          if (page.staleArtifactInputs.length > 0) {
            headers.set("x-pletivo-artifact-stale", page.staleArtifactInputs.join(","));
          }
          return new Response(page.html, { headers });
        });
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

/** The inputs whose bytes under `root` no longer have the digest `prepare` recorded, sorted. */
async function changedInputs(
  inputs: readonly ArtifactInput[],
  snapshot: ProjectSnapshot,
  root: string,
): Promise<string[]> {
  const encoder = new TextEncoder();
  const stale: string[] = [];
  for (const input of inputs) {
    const path = root === "" ? input.path : `${root}/${input.path}`;
    let bytes: Uint8Array | undefined;
    if (snapshot.readBytes) {
      bytes = snapshot.readBytes(path);
    } else {
      const source = snapshot.files.get(path);
      bytes = source === undefined ? undefined : encoder.encode(source);
    }
    const digest = bytes === undefined ? undefined : await digestArtifactInput(bytes);
    if (digest !== input.digest) stale.push(input.path);
  }
  return stale.sort();
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

function errorResponse(error: unknown): Response {
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
