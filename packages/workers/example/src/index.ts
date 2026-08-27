/**
 * A request-scoped preview server for a project supplied as JSON.
 *
 *   bunx wrangler dev --config packages/workers/example/wrangler.jsonc
 *
 *   GET  /            render the demo project in src/site.ts
 *   POST /__render    render the project in the request body
 *   POST /__paths     enumerate that request body's project
 *
 * This example deliberately has no cross-request project storage. The Durable Object
 * playground is the production-correct example for live workspaces and content. Assets
 * are rejected at the request boundary, and generated asset URLs fail the render because
 * this host cannot answer their follow-up GET. Content imports reach the compiler and
 * report the authoritative ContentUnavailableError because this preview owns no binding.
 */

import { parsePreparedSite, type PreparedSite } from "@pletivo/workers/artifact";
import { createMapProjectStore } from "@pletivo/workers/project-store";
import { createProjectHost } from "@pletivo/workers/project-host";
import type { ProjectEnv } from "@pletivo/workers/env";
import type { OutboundBinding } from "@pletivo/workers/outbound";
import {
  ContentUnavailableError,
  type WorkerLoaderBinding,
} from "@pletivo/workers/render";
import { WorkerEntrypoint } from "cloudflare:workers";
import { API_ORIGIN, apiResponse } from "./api.ts";
import { SITE } from "./site.ts";
import { TAILWIND } from "./tailwind.ts";

interface Env {
  LOADER: WorkerLoaderBinding;
  PLETIVO_API_BASE?: string;
  PLETIVO_API_TOKEN?: string;
}

interface RenderContext {
  exports: {
    PletivoOutbound: (options: { props?: unknown }) => OutboundBinding;
  };
}

const COMPATIBILITY_DATE = "2026-01-01";
const COMPATIBILITY_FLAGS = ["nodejs_compat"];

/** A closed outbound proxy used only when a request explicitly asks for it. */
export class PletivoOutbound extends WorkerEntrypoint {
  fetch(request: Request): Response {
    const url = new URL(request.url);
    if (url.origin !== API_ORIGIN) {
      return new Response(`[example] the render isolate may not reach ${url.origin}`, {
        status: 403,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return apiResponse(url.pathname, request.headers.get("authorization"));
  }
}

interface RenderRequest {
  files: Record<string, string>;
  pathname?: string;
  pagesDir?: string;
  site?: string;
  outbound?: string;
  /** Stable project identity required when the proxy becomes an isolate capability. */
  tenant?: string;
  /** Host-controlled generation for the proxy wiring named above. */
  capabilityGeneration?: string;
  artifact?: unknown;
}

interface ParsedRender {
  files: ReadonlyMap<string, string>;
  pathname: string;
  pagesDir?: string;
  site?: string;
  proxyOutbound: boolean;
  tenant?: string;
  capabilityGeneration?: string;
  artifact?: PreparedSite;
}

function isRenderRequest(value: unknown): value is RenderRequest {
  if (typeof value !== "object" || value === null) return false;
  const files: unknown = Reflect.get(value, "files");
  if (typeof files !== "object" || files === null) return false;
  return Object.values(files).every((source) => typeof source === "string");
}

function requireIdentity(value: string | undefined, field: string): string {
  if (value === undefined || value.trim() === "") {
    throw new Error(`POST /__render with outbound=proxy requires a non-empty ${field}`);
  }
  return value;
}

async function readRenderRequest(request: Request): Promise<ParsedRender> {
  const body: unknown = await request.json();
  if (typeof body === "object" && body !== null && Reflect.has(body, "assets")) {
    throw new Error(
      "This stateless preview does not accept assets because it cannot serve them on a follow-up request.",
    );
  }
  if (!isRenderRequest(body)) {
    throw new Error('POST /__render wants {"files": {path: source}, "pathname": "/"}');
  }
  const files = new Map(Object.entries(body.files));
  const artifact = body.artifact === undefined ? undefined : parsePreparedSite(body.artifact);
  const proxyOutbound = body.outbound === "proxy";
  return {
    files,
    pathname: body.pathname ?? "/",
    pagesDir: body.pagesDir,
    site: body.site,
    proxyOutbound,
    ...(proxyOutbound
      ? {
          tenant: requireIdentity(body.tenant, "tenant"),
          capabilityGeneration: requireIdentity(
            body.capabilityGeneration,
            "capabilityGeneration",
          ),
        }
      : {}),
    ...(artifact === undefined ? {} : { artifact }),
  };
}

function siteEnv(env: Env): ProjectEnv {
  const server: Record<string, string> = {};
  if (env.PLETIVO_API_BASE) server.API_BASE = env.PLETIVO_API_BASE;
  if (env.PLETIVO_API_TOKEN) server.API_TOKEN = env.PLETIVO_API_TOKEN;
  return { server };
}

function requestHost(
  parsed: ParsedRender,
  env: Env,
  ctx: RenderContext,
) {
  return createProjectHost({
    store: createMapProjectStore(parsed.files),
    loader: env.LOADER,
    compileCache: false,
    generatedAssetCache: { maxEntries: 0, maxBytes: 0 },
    pagesDir: parsed.pagesDir,
    site: parsed.site,
    artifact: parsed.artifact,
    tailwind: TAILWIND,
    env: siteEnv(env),
    compatibilityDate: COMPATIBILITY_DATE,
    compatibilityFlags: COMPATIBILITY_FLAGS,
    outbound: parsed.proxyOutbound
      ? { kind: "proxy", binding: ctx.exports.PletivoOutbound({}) }
      : { kind: "blocked" },
    ...(parsed.proxyOutbound
      ? {
          executionNamespace: {
            tenant: parsed.tenant ?? "",
            capabilityGeneration: parsed.capabilityGeneration ?? "",
          },
        }
      : {}),
  });
}

function defaultRender(pathname: string): ParsedRender {
  return {
    files: SITE,
    pathname,
    proxyOutbound: false,
  };
}

function exampleError(error: unknown): Response {
  const detail =
    error instanceof ContentUnavailableError
      ? `[example] This stateless preview has no content binding. Use example-playground for content collections.\n${error.name}: ${error.message}`
      : error instanceof Error
        ? (error.stack ?? error.message)
        : String(error);
  return new Response(detail, {
    status: 500,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: RenderContext): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/__paths") {
        const parsed = await readRenderRequest(request);
        return Response.json(await requestHost(parsed, env, ctx).paths());
      }
      if (url.pathname === "/__render") {
        const parsed = await readRenderRequest(request);
        const page = await requestHost(parsed, env, ctx).render(parsed.pathname);
        return new Response(page.html, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      return requestHost(defaultRender(url.pathname), env, ctx).fetch(request);
    } catch (error) {
      return exampleError(error);
    }
  },
};
