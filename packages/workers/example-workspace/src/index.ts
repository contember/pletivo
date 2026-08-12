/**
 * The live workspace: a project that lives in a Durable Object and is rendered by it.
 *
 *   bunx wrangler@4 dev --config packages/workers/example-workspace/wrangler.jsonc
 *
 *   GET    /              render a page out of the workspace
 *   GET    /__paths       every page the project can enumerate
 *   GET    /__files       what is in the workspace right now
 *   PUT    /__files/<path>  write one file — this is the agent's edit
 *   DELETE /__files/<path>  remove one file
 *
 * What `example/` cannot do: `PUT` a component and `GET` the page again. There is no
 * build step between the two, and nothing was handed in with the request — the DO owns
 * the sources, and the next render reads them where they lie. That is the shape
 * `docs/todos/023` describes, and the reason `artifact.json` has to stop being the way
 * a project reaches this host.
 *
 * The composition is the point:
 *
 *   SQLiteWorkspaceProvider  ->  createWorkspaceProjectStore  ->  createProjectHost
 *
 * Everything below `ProjectDO` is a plain object built by a factory. The class holds
 * what only a Durable Object can have — the storage and the bindings — and forwards.
 */

import { Workspace } from "@cloudflare/computer";
import type { DurableObjectStorageLike } from "@cloudflare/computer";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { ContentFiles } from "../../src/content-files.ts";
import type { ContentFileRef, ImageInfo } from "../../src/content-files.ts";
import { createProjectHost, type ProjectHost } from "../../src/project-host.ts";
import type { WorkerLoaderBinding } from "../../src/render.ts";
import { createWorkspaceProjectStore, vfsRevision } from "../../src/workspace-store.ts";
import { TAILWIND } from "../../example/src/tailwind.ts";
import { SITE } from "../../example/src/site.ts";

interface Env {
  PROJECT: DurableObjectNamespace<ProjectDO>;
  LOADER: WorkerLoaderBinding;
}

/** Where the project sits in the workspace. Everything else there is not a source. */
const PROJECT_ROOT = "/project";

/**
 * Content files the renders in flight are reading.
 *
 * Module-level, and shared with the entrypoint below, because a `WorkerEntrypoint` is
 * constructed per call and cannot hold state. The DO and the entrypoint are the same
 * script, so one module-level store serves both.
 */
const CONTENT = new ContentFiles();

/** The loopback the render isolate calls to read collections. See `content-files.ts`. */
export class PletivoContent extends WorkerEntrypoint {
  scan(ref: string, dir: string, pattern: string): ContentFileRef[] {
    return CONTENT.scan(ref, dir, pattern);
  }
  read(ref: string, path: string): string | null {
    return CONTENT.read(ref, path);
  }
  image(ref: string, path: string): ImageInfo | null {
    return CONTENT.image(ref, path);
  }
}

export class ProjectDO extends DurableObject<Env> {
  readonly #workspace: Workspace;
  readonly #host: ProjectHost;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // computer types `exec<Row extends object>`, workers-types
    // `exec<T extends Record<string, SqlStorageValue>>` — the parameter is phantom at
    // run time and no assignment between the two is sound. Same assertion, and the same
    // reason, as `@roj-ai/computer-worker`.
    const storage = ctx.storage as unknown as DurableObjectStorageLike;
    this.#workspace = new Workspace({ storage });
    const provider = this.#workspace.provider();
    this.#host = createProjectHost({
      store: createWorkspaceProjectStore(provider, {
        root: PROJECT_ROOT,
        // One primary-key lookup per request instead of a walk of the tree. The DO is
        // the single writer, so this counter is the whole invalidation story — no
        // hashing, no key, no staleness window. See docs/todos/023 §3.
        revision: vfsRevision(this.#workspace.db),
      }),
      loader: this.env.LOADER,
      // Only the app object has `ctx.exports`, and inside a DO that is `ctx` here —
      // the isolate calls back into this same script to read collection files.
      content: { binding: ctx.exports.PletivoContent({}), store: CONTENT },
      tailwind: TAILWIND,
      // Read from the workspace, not from the request: `bun install` writing a new one
      // is a file change like any other. Absent, a project with no npm deps still
      // renders, which is what the demo project is.
      artifactPath: "pletivo-artifact.json",
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.#seed();
    const url = new URL(request.url);

    if (url.pathname === "/__paths") {
      return Response.json(await this.#host.paths());
    }
    if (url.pathname === "/__files") {
      const { files, assets, revision } = await this.#host.snapshot();
      return Response.json({ revision, files: [...files.keys()], assets: [...assets.keys()] });
    }
    if (url.pathname.startsWith("/__files/")) {
      return this.#file(request, url.pathname.slice("/__files/".length));
    }
    return this.#host.fetch(request);
  }

  /** One file, written or removed the way an agent with this workspace mounted would. */
  async #file(request: Request, relative: string): Promise<Response> {
    if (relative === "" || relative.includes("..")) {
      return new Response("bad path", { status: 400 });
    }
    const path = `${PROJECT_ROOT}/${relative}`;
    const provider = this.#workspace.provider();

    if (request.method === "PUT") {
      const directory = path.slice(0, path.lastIndexOf("/"));
      await provider.mkdir(directory, { recursive: true });
      await provider.writeFile(path, await request.text());
      return new Response(`wrote ${relative}\n`, { status: 201 });
    }
    if (request.method === "DELETE") {
      await provider.unlink(path);
      return new Response(`removed ${relative}\n`);
    }
    if (request.method === "GET") {
      const source = await provider.readFile(path, "utf-8");
      return new Response(typeof source === "string" ? source : source.toString("utf-8"), {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return new Response("PUT, DELETE or GET", { status: 405 });
  }

  /**
   * Put the demo project in the workspace the first time it is asked for anything.
   *
   * A real host seeds from a git clone or an agent's first write; the point of the
   * prototype is what happens *after*, so the seed is the one in `example/src/site.ts`
   * and it happens once.
   */
  async #seed(): Promise<void> {
    const provider = this.#workspace.provider();
    if (provider.existsSync(`${PROJECT_ROOT}/src/pages/index.astro`)) return;
    for (const [relative, source] of SITE) {
      const path = `${PROJECT_ROOT}/${relative}`;
      await provider.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
      await provider.writeFile(path, source);
    }
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    // One project, so one Durable Object. A host serving many would take the name from
    // the hostname or the path, and every project would get its own render thread —
    // which is the trade docs/todos/023 §8 leaves open.
    return env.PROJECT.get(env.PROJECT.idFromName("project")).fetch(request);
  },
};
