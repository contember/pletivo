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
  digestArtifactInput,
  type ArtifactInput,
} from "@pletivo/core/artifact";
import { loadProjectArtifact, type ProjectArtifact } from "./artifact.ts";
import { createCompileCache, type CompileCache } from "./compile-cache.ts";
import { GeneratedAssetCache } from "./asset-cache.ts";
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
  type ProjectOptions,
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
  /** How many generated (content-hashed) files to keep for the browser's follow-up GET. */
  generatedAssetCache?: { maxEntries: number; maxBytes: number };
}

export interface ProjectHost {
  /**
   * Serve one request: a generated asset, an image, or a rendered page. Throws nothing:
   * failures become status codes. Call `render()` to handle them yourself.
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
  const {
    store,
    site,
    compileCache: compileCacheOption,
    artifactPath,
    artifact: artifactValue,
    generatedAssetCache,
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

  async function renderSnapshot(pathname: string, snapshot: ProjectSnapshot): Promise<RenderedPage> {
    const project = projectOptions(snapshot);
    const stale = await staleArtifactInputs(snapshot, project.artifact);
    const page = await renderPage({ ...project, pathname, site });
    const rejected = served.putAll(page.assets);
    if (rejected.length > 0) {
      throw new GeneratedAssetRetentionError(rejected.map((asset) => asset.path));
    }
    return { ...page, staleArtifactInputs: stale };
  }

  return {
    render: (pathname) => withSnapshot((snapshot) => renderSnapshot(pathname, snapshot)),

    paths: () => withSnapshot((snapshot) => projectPaths(projectOptions(snapshot))),

    snapshot: () => store.snapshot(),

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
