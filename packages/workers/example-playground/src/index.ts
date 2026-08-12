/**
 * The playground: edit a source file in the browser, see the page re-render.
 *
 *   bunx wrangler@4 dev --config packages/workers/example-playground/wrangler.jsonc
 *   open http://localhost:8787/__playground
 *
 *   GET    /__playground     the editor
 *   GET    /__paths          every page the project can enumerate
 *   GET    /__files          what is in the workspace right now
 *   GET    /__files/<path>   one source
 *   PUT    /__files/<path>   write one source — this is the edit
 *   DELETE /__files/<path>   remove one source
 *   POST   /__reset          throw the edits away and re-seed
 *   GET    /<anything>       render that page out of the workspace
 *
 * There is no build step anywhere in that list. The sources live in the Durable
 * Object's SQLite; a `PUT` moves the workspace's revision counter, and the next `GET`
 * reads, compiles and renders whatever is there now. That is what `example-workspace`
 * demonstrates over `curl`, with a UI in front of it and a project worth editing.
 *
 * The composition is unchanged and is the point:
 *
 *   SQLiteWorkspaceProvider  ->  createWorkspaceProjectStore  ->  createProjectHost
 *
 * Everything below `ProjectDO` is a plain object built by a factory. The class holds
 * what only a Durable Object can have — the storage and the bindings — and forwards.
 */

import { Workspace } from "@cloudflare/computer";
import type { DurableObjectStorageLike } from "@cloudflare/computer";
import { DurableObject } from "cloudflare:workers";
import { ContentFiles } from "../../src/content-files.ts";
import type { ContentFileRef, ImageInfo } from "../../src/content-files.ts";
import { createProjectHost, type ProjectHost } from "../../src/project-host.ts";
import type { WorkerLoaderBinding } from "../../src/render.ts";
import {
  createWorkspaceProjectStore,
  vfsRevision,
  type WorkspaceDirent,
  type WorkspaceFiles,
} from "../../src/workspace-store.ts";
import { TAILWIND } from "../../example/src/tailwind.ts";
import { SEED } from "./seed.ts";
import PLAYGROUND_HTML from "./playground.html";

interface Env {
  PROJECT: DurableObjectNamespace<ProjectDO>;
  LOADER: WorkerLoaderBinding;
}

/** Where the project sits in the workspace. Everything else there is not a source. */
const PROJECT_ROOT = "/project";

/** The one object, since the playground is one project. */
const INSTANCE = "playground";

export class ProjectDO extends DurableObject<Env> {
  readonly #workspace: Workspace;
  readonly #host: ProjectHost;
  /**
   * Content files the renders in flight are reading.
   *
   * An instance field, and the object itself is the binding — see `#scan` below.
   */
  readonly #content = new ContentFiles();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // computer types `exec<Row extends object>`, workers-types
    // `exec<T extends Record<string, SqlStorageValue>>` — the parameter is phantom at
    // run time and no assignment between the two is sound. Same assertion, and the same
    // reason, as `@roj-ai/computer-worker`.
    const storage = ctx.storage as unknown as DurableObjectStorageLike;
    this.#workspace = new Workspace({ storage });
    this.#host = createProjectHost({
      store: createWorkspaceProjectStore(this.#workspace.provider(), {
        root: PROJECT_ROOT,
        // One primary-key lookup per request instead of a walk of the tree. The DO is
        // the single writer, so this counter is the whole invalidation story — no
        // hashing, no key, no staleness window. See docs/todos/023 §3.
        revision: vfsRevision(this.#workspace.db),
      }),
      loader: this.env.LOADER,
      // A stub to this very object, because the thing that owns the files has to be
      // the thing that answers for them. See the note on `scan` below.
      content: { binding: env.PROJECT.get(ctx.id), store: this.#content },
      tailwind: TAILWIND,
    });
  }

  /**
   * `ContentBinding`, implemented by the Durable Object itself.
   *
   * The obvious shape is a `WorkerEntrypoint` in the same script, reading a
   * module-level `ContentFiles` that the DO also writes to. **It does not work in
   * production.** Measured on workerd behind `workers.dev`: a DO and a
   * `WorkerEntrypoint` from one script run in two isolates with two module records and
   * two stores, so the ref the DO opened does not exist on the side the render asks —
   * every page with a collection is a 500 and every page without one is fine.
   * `wrangler dev` puts both in one isolate and shows none of it.
   *
   * So the binding is a stub to this object. `content-files.ts` names exactly this as a
   * valid implementation, and it is the only one where opening a ref and answering for
   * it happen in the same place. The call is re-entrant — the DO is awaiting the render
   * that makes it — which is fine because these three methods touch no storage and a
   * Durable Object accepts events while it awaits I/O.
   */
  scan(ref: string, dir: string, pattern: string): ContentFileRef[] {
    return this.#content.scan(ref, dir, pattern);
  }
  read(ref: string, path: string): string | null {
    return this.#content.read(ref, path);
  }
  image(ref: string, path: string): ImageInfo | null {
    return this.#content.image(ref, path);
  }

  async fetch(request: Request): Promise<Response> {
    this.#seed();
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
    if (url.pathname === "/__reset") {
      if (request.method !== "POST") return new Response("POST", { status: 405 });
      this.#reset();
      return new Response("reset\n");
    }
    return asErrorPage(await this.#host.fetch(request), request);
  }

  /** One file, written or removed the way an agent with this workspace mounted would. */
  #file(request: Request, relative: string): Promise<Response> | Response {
    if (relative === "" || relative.includes("..")) {
      return new Response("bad path", { status: 400 });
    }
    const path = `${PROJECT_ROOT}/${relative}`;
    const provider = this.#workspace.provider();

    if (request.method === "PUT") {
      return request.text().then((source) => {
        provider.mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
        provider.writeFileSync(path, source);
        return new Response(`wrote ${relative}\n`, { status: 201 });
      });
    }
    if (request.method === "DELETE") {
      if (!provider.existsSync(path)) return new Response("no such file", { status: 404 });
      provider.unlinkSync(path);
      return new Response(`removed ${relative}\n`);
    }
    if (request.method === "GET") {
      if (!provider.existsSync(path)) return new Response("no such file", { status: 404 });
      const source = provider.readFileSync(path, "utf-8");
      return new Response(typeof source === "string" ? source : new TextDecoder().decode(source), {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return new Response("PUT, DELETE or GET", { status: 405 });
  }

  /**
   * Put the demo project in the workspace the first time it is asked for anything.
   *
   * A real host seeds from a git clone or an agent's first write; the point of the
   * playground is what happens *after*, so the seed is `seed.ts` and it happens once.
   */
  #seed(): void {
    const provider = this.#workspace.provider();
    if (provider.existsSync(`${PROJECT_ROOT}/src/pages/index.astro`)) return;
    for (const [relative, source] of SEED) {
      const path = `${PROJECT_ROOT}/${relative}`;
      provider.mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
      provider.writeFileSync(path, source);
    }
  }

  /**
   * Back to the project as shipped.
   *
   * Every file is removed before the seed is written, so a file the visitor *added*
   * goes away too — re-seeding over the top would leave it behind and the next visitor
   * would inherit it. Emptied directories are left; the store walks files.
   */
  #reset(): void {
    const provider = this.#workspace.provider();
    for (const path of walkFiles(provider, PROJECT_ROOT)) provider.unlinkSync(path);
    this.#seed();
  }
}

/**
 * A failure, as something a browser can show.
 *
 * `createProjectHost` answers a broken page with the stack as `text/plain`, which is
 * right for a library and for `curl`. In an iframe it renders as a blank white pane —
 * the message is in the document and invisible — so the one failure a playground exists
 * to show is the one it hides. Presentation belongs to the host, so it happens here
 * rather than in the package.
 */
async function asErrorPage(response: Response, request: Request): Promise<Response> {
  if (response.ok) return response;
  if (!response.headers.get("content-type")?.startsWith("text/plain")) return response;
  if (!request.headers.get("accept")?.includes("text/html")) return response;
  return errorPage(response.status, await response.text());
}

/** The stack, legibly, with nothing to load. */
function errorPage(status: number, detail: string): Response {
  const title = status === 404 ? "No such page" : "This page did not render";
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>${status}</title>
<style>
  :root { color-scheme: dark }
  body { margin: 0; padding: 28px 32px; background: #12070b; color: #ffb4c0;
         font: 13px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace }
  h1 { margin: 0 0 4px; color: #f7768e; font: 600 15px/1.4 ui-sans-serif, system-ui, sans-serif }
  p { margin: 0 0 18px; color: #b4818c; font: 12px/1.5 ui-sans-serif, system-ui, sans-serif }
  pre { margin: 0; padding: 14px 16px; border: 1px solid #3a1d25; border-radius: 4px;
        background: #1a0d12; color: #ffd2da; overflow-x: auto; white-space: pre-wrap;
        word-break: break-word }
</style></head>
<body><h1>${title}</h1><p>HTTP ${status} · the workspace is unchanged, fix the source and save again</p>
<pre>${escapeHtml(detail)}</pre></body></html>
`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** Every file under `directory`. Order does not matter — each one is unlinked. */
function walkFiles(provider: WorkspaceFiles, directory: string): string[] {
  const found: string[] = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) continue;
    let entries: string[] | WorkspaceDirent[];
    try {
      entries = provider.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      // A provider that ignored `withFileTypes` would hand back names, and nothing can
      // be decided from a name. Same guard as `workspace-store.ts`.
      if (typeof entry === "string") continue;
      const path = `${current}/${entry.name}`;
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) found.push(path);
    }
  }
  return found;
}

export default {
  fetch(request: Request, env: Env): Promise<Response> | Response {
    const url = new URL(request.url);
    // The editor is the only thing this worker serves itself. Everything else, the
    // rendered site included, belongs to the object that owns the sources.
    if (url.pathname === "/__playground" || url.pathname === "/__playground/") {
      return new Response(PLAYGROUND_HTML, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    // One project, so one Durable Object. A host serving many would take the name from
    // the hostname or the path, and every project would get its own render thread —
    // which is the trade docs/todos/023 §8 leaves open.
    return env.PROJECT.get(env.PROJECT.idFromName(INSTANCE)).fetch(request);
  },
};
