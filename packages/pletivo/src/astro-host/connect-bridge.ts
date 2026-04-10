/**
 * Connect ↔ Fetch bridge.
 *
 * Astro integrations register middleware via `server.middlewares.use(mw)`
 * where `mw` is Connect-style: `(req, res, next) => void`, using Node's
 * http.IncomingMessage / http.ServerResponse interfaces.
 *
 * Pletivo's dev server is Bun.serve which speaks Fetch API Request/Response.
 * We build lightweight mocks that satisfy the subset of Node http APIs
 * that real integrations actually touch, walk the middleware chain, and
 * convert the collected response back to a Fetch `Response`.
 *
 * Subset implemented:
 *   req: url, originalUrl, method, headers, httpVersion, socket (stub),
 *        on('data' | 'end' | 'error'), pause/resume (stubs), pipe
 *   res: setHeader, getHeader, removeHeader, statusCode, statusMessage,
 *        writeHead, write, end, hasHeader, headersSent, getHeaderNames,
 *        on('close' | 'finish') — stubs
 */

import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import type { ConnectMiddleware } from "./types";

interface MockReq extends Readable {
  url?: string;
  originalUrl?: string;
  method?: string;
  headers: Record<string, string | string[]>;
  httpVersion: string;
  socket: { remoteAddress?: string; remotePort?: number };
  connection: { remoteAddress?: string; remotePort?: number };
}

interface MockRes extends Writable {
  statusCode: number;
  statusMessage: string;
  headersSent: boolean;
  _headers: Record<string, string | number | string[]>;
  _chunks: Buffer[];
  _done: boolean;
  _resolve: (r: Response) => void;
  setHeader(name: string, value: string | number | string[]): MockRes;
  getHeader(name: string): string | number | string[] | undefined;
  getHeaderNames(): string[];
  hasHeader(name: string): boolean;
  removeHeader(name: string): void;
  writeHead(
    status: number,
    statusOrHeaders?: string | Record<string, string | number>,
    maybeHeaders?: Record<string, string | number>,
  ): MockRes;
  write(chunk: string | Uint8Array, encodingOrCb?: string | (() => void)): boolean;
  end(chunkOrCb?: unknown, encodingOrCb?: unknown): MockRes;
}

/**
 * Walk a Connect middleware chain against a Fetch Request.
 *
 * Two outcomes:
 *  1. Some middleware ends the response itself (e.g. Nua CMS API handler
 *     calls `res.end(json)`). Returns the resulting `Response`.
 *  2. All middlewares call `next()` and the chain exhausts. We then invoke
 *     the optional `finalHandler` callback to obtain pletivo's own
 *     Response, pipe it through `res.write`+`res.end` so that any
 *     response-transforming wrappers (e.g. CMS HTML marker) get to run,
 *     and return the transformed Response.
 *
 * If `finalHandler` is omitted, returns `null` when the chain exhausts
 * without ending — caller falls back to direct routing.
 */
export async function dispatchMiddlewares(
  request: Request,
  middlewares: ConnectMiddleware[],
  finalHandler?: () => Promise<Response | null>,
): Promise<Response | null> {
  if (middlewares.length === 0) {
    return finalHandler ? await finalHandler() : null;
  }

  const bodyBuf = await readRequestBody(request);

  const req = createMockReq(request, bodyBuf);
  let resolveResponse!: (r: Response) => void;
  const responsePromise = new Promise<Response>((res) => {
    resolveResponse = res;
  });
  const res = createMockRes(resolveResponse);

  let index = 0;
  let chainError: unknown = null;
  let reachedEnd = false;

  const next = async (err?: unknown): Promise<void> => {
    if (err != null) {
      chainError = err;
      reachedEnd = true;
      return;
    }
    if (res._done) return;
    const mw = middlewares[index++];
    if (!mw) {
      // End of middleware chain. Run pletivo's final handler, then pipe
      // the returned Response through `res` so any response wrappers
      // installed by earlier middleware get a chance to transform it.
      reachedEnd = true;
      if (!finalHandler) return;
      let finalResponse: Response | null;
      try {
        finalResponse = await finalHandler();
      } catch (e) {
        chainError = e;
        return;
      }
      if (!finalResponse || res._done) return;
      await pipeResponseIntoMockRes(finalResponse, res);
      return;
    }
    try {
      await mw(req as never, res as never, next);
    } catch (err2) {
      chainError = err2;
      reachedEnd = true;
    }
  };

  await next();

  // Middlewares that spawn background work still need time to resolve
  // the response. Poll until either response settles or we time out.
  const startedAt = Date.now();
  while (!res._done) {
    if (chainError) break;
    if (reachedEnd && !finalHandler) break;
    if (Date.now() - startedAt > 30_000) {
      throw new Error("Middleware chain timed out after 30s");
    }
    await new Promise((r) => setImmediate(r));
  }

  if (chainError) {
    console.error("[pletivo-astro-host] middleware error:", chainError);
    return new Response("Internal server error", { status: 500 });
  }

  if (!res._done) {
    // Chain exhausted without ending and no final handler — pass through
    return null;
  }

  return await responsePromise;
}

/**
 * Copy a Fetch `Response` into a mock `res` object via the same
 * `setHeader` / `write` / `end` calls a real handler would use. This
 * way any wrappers installed on `res.write` / `res.end` by upstream
 * middleware (Nua CMS HTML marker, for example) intercept the output
 * exactly as they would in Astro + Vite.
 */
async function pipeResponseIntoMockRes(response: Response, res: unknown): Promise<void> {
  const mockRes = res as {
    statusCode: number;
    setHeader: (n: string, v: string) => void;
    end: (chunk?: Buffer) => void;
    _done: boolean;
  };
  mockRes.statusCode = response.status;
  response.headers.forEach((value, key) => {
    mockRes.setHeader(key, value);
  });
  const buf = await response.arrayBuffer();
  if (buf.byteLength > 0) {
    mockRes.end(Buffer.from(buf));
  } else {
    mockRes.end();
  }
}

async function readRequestBody(request: Request): Promise<Buffer | null> {
  if (request.method === "GET" || request.method === "HEAD") return null;
  try {
    const buf = await request.arrayBuffer();
    if (buf.byteLength === 0) return null;
    return Buffer.from(buf);
  } catch {
    return null;
  }
}

function createMockReq(request: Request, body: Buffer | null): MockReq {
  const url = new URL(request.url);
  // Connect expects `req.url` to be the path + query, not the full URL
  const pathAndQuery = url.pathname + url.search;

  const headers: Record<string, string | string[]> = {};
  request.headers.forEach((value, key) => {
    const existing = headers[key];
    if (existing === undefined) {
      headers[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      headers[key] = [existing, value];
    }
  });

  const req = new Readable({
    read() {
      if (body) {
        this.push(body);
        this.push(null);
      } else {
        this.push(null);
      }
    },
  }) as unknown as MockReq;

  req.url = pathAndQuery;
  req.originalUrl = pathAndQuery;
  req.method = request.method;
  req.headers = headers;
  req.httpVersion = "1.1";
  req.socket = { remoteAddress: "127.0.0.1", remotePort: 0 };
  req.connection = req.socket;

  return req;
}

function createMockRes(resolve: (r: Response) => void): MockRes {
  const writable = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      const c = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      (writable as unknown as MockRes)._chunks.push(c);
      cb();
    },
  }) as unknown as MockRes;

  // Silence EventEmitter `error` warnings — Connect-style middlewares often
  // don't install error listeners and Node rethrows unhandled 'error'.
  (writable as unknown as EventEmitter).on("error", () => {});

  writable.statusCode = 200;
  writable.statusMessage = "OK";
  writable.headersSent = false;
  writable._headers = {};
  writable._chunks = [];
  writable._done = false;
  writable._resolve = resolve;

  writable.setHeader = function (name: string, value: string | number | string[]): MockRes {
    writable._headers[name.toLowerCase()] = value;
    return writable;
  };
  writable.getHeader = function (name: string) {
    return writable._headers[name.toLowerCase()];
  };
  writable.getHeaderNames = function () {
    return Object.keys(writable._headers);
  };
  writable.hasHeader = function (name: string) {
    return name.toLowerCase() in writable._headers;
  };
  writable.removeHeader = function (name: string) {
    delete writable._headers[name.toLowerCase()];
  };
  writable.writeHead = function (
    status: number,
    statusOrHeaders?: string | Record<string, string | number>,
    maybeHeaders?: Record<string, string | number>,
  ): MockRes {
    writable.statusCode = status;
    let headers: Record<string, string | number> | undefined;
    if (typeof statusOrHeaders === "string") {
      writable.statusMessage = statusOrHeaders;
      headers = maybeHeaders;
    } else {
      headers = statusOrHeaders;
    }
    if (headers) {
      for (const [k, v] of Object.entries(headers)) {
        writable._headers[k.toLowerCase()] = v;
      }
    }
    writable.headersSent = true;
    return writable;
  };

  const origEnd = writable.end.bind(writable);
  writable.end = function (
    chunkOrCb?: unknown,
    _encodingOrCb?: unknown,
    _cb?: unknown,
  ): MockRes {
    if (writable._done) return writable;
    if (chunkOrCb != null && typeof chunkOrCb !== "function") {
      const c =
        typeof chunkOrCb === "string"
          ? Buffer.from(chunkOrCb)
          : chunkOrCb instanceof Uint8Array
            ? Buffer.from(chunkOrCb)
            : Buffer.from(String(chunkOrCb));
      writable._chunks.push(c);
    }
    writable._done = true;
    writable.headersSent = true;

    const body = writable._chunks.length > 0 ? Buffer.concat(writable._chunks) : null;
    const headers = new Headers();
    for (const [k, v] of Object.entries(writable._headers)) {
      if (Array.isArray(v)) {
        for (const item of v) headers.append(k, String(item));
      } else {
        headers.set(k, String(v));
      }
    }

    writable._resolve(
      new Response(body, {
        status: writable.statusCode,
        statusText: writable.statusMessage,
        headers,
      }),
    );

    // Still invoke the underlying Writable end so stream consumers resolve
    try {
      origEnd();
    } catch {
      // ignore
    }
    return writable;
  };

  return writable;
}
