import type { Route, RouteParams } from "@pletivo/core/router";
import type { UnresolvedReason } from "./render.ts";

/** What the content binding is called in the isolate's `env`. */
export const CONTENT_BINDING = "PLETIVO_CONTENT";

/**
 * The exports of the per-program data module the host generates. Named here, where
 * both sides can see them without the host importing the isolate's runtime.
 */
export type IsolateProgramExport =
  | "pages"
  | "contentConfig"
  | "content"
  | "envInstallers"
  | "importMetaEnv";

/** Null preserves a route param whose value was `undefined` before JSON encoding. */
export type IsolateParamPair = [name: string, value: string | null];

/**
 * Params cross as pairs, not as an object: `JSON.stringify` drops a key whose value is
 * `undefined`, and `{ page: undefined }` arriving as `{}` would match the wrong path.
 */
export function encodeParams(params: Readonly<RouteParams>): IsolateParamPair[] {
  return Object.keys(params).map((name): IsolateParamPair => [name, params[name] ?? null]);
}

export function decodeParams(pairs: readonly IsolateParamPair[]): RouteParams {
  const params: RouteParams = {};
  for (const [name, value] of pairs) params[name] = value === null ? undefined : value;
  return params;
}

export interface IsolatePathRoute {
  file: string;
  route: Route;
}

interface IsolateRequestBase {
  contentRef?: string;
  rootDir?: string;
}

export interface IsolateRenderRequest extends IsolateRequestBase {
  op: "render";
  file: string;
  params: IsolateParamPair[];
  route: Route | null;
  url: string;
  site?: string;
}

export interface IsolatePathsRequest extends IsolateRequestBase {
  op: "paths";
  routes: IsolatePathRoute[];
}

export type IsolateRequest = IsolateRenderRequest | IsolatePathsRequest;

export interface IsolateRenderedResponse {
  status: "rendered";
  html: string;
  renderedModules: string[];
  tsxStyles: string[];
}

export interface IsolateUnresolvedResponse {
  status: "unresolved";
  reason: UnresolvedReason;
}

export interface IsolatePathsResponse {
  status: "paths";
  paths: Record<string, IsolateParamPair[][]>;
}

export interface IsolateErrorResponse {
  status: "error";
  message: string;
  stack?: string;
}

export type IsolateResponse =
  | IsolateRenderedResponse
  | IsolateUnresolvedResponse
  | IsolatePathsResponse
  | IsolateErrorResponse;

export class IsolateProtocolError extends Error {
  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(`[pletivo-workers] invalid isolate protocol at ${path}: ${reason}`);
    this.name = "IsolateProtocolError";
  }
}

/**
 * The response is checked and the request is not: the host builds the request, but
 * user code runs in the isolate that writes the response.
 */
export function parseIsolateResponse(value: unknown): IsolateResponse {
  if (!isRecord(value)) throw new IsolateProtocolError("$", "expected an object");
  const { status } = value;
  if (status === "rendered") {
    const { html, renderedModules, tsxStyles } = value;
    if (typeof html !== "string") throw new IsolateProtocolError("$.html", "expected a string");
    if (!isStringArray(renderedModules)) {
      throw new IsolateProtocolError("$.renderedModules", "expected a string array");
    }
    if (!isStringArray(tsxStyles)) {
      throw new IsolateProtocolError("$.tsxStyles", "expected a string array");
    }
    return { status, html, renderedModules, tsxStyles };
  }
  if (status === "unresolved") {
    const { reason } = value;
    if (reason !== "no-static-path" && reason !== "not-enumerable") {
      throw new IsolateProtocolError("$.reason", "unknown unresolved reason");
    }
    return { status, reason };
  }
  if (status === "paths") return { status, paths: parsePaths(value.paths) };
  if (status === "error") {
    const { message, stack } = value;
    if (typeof message !== "string") throw new IsolateProtocolError("$.message", "expected a string");
    return { status, message, ...(typeof stack === "string" ? { stack } : {}) };
  }
  throw new IsolateProtocolError("$.status", "unknown response status");
}

function parsePaths(value: unknown): Record<string, IsolateParamPair[][]> {
  if (!isRecord(value)) throw new IsolateProtocolError("$.paths", "expected an object");
  const entries = Object.entries(value).map(([file, sets]): [string, IsolateParamPair[][]] => {
    if (!isParamPairSets(sets)) {
      throw new IsolateProtocolError(`$.paths.${file}`, "expected a list of param pair lists");
    }
    return [file, sets];
  });
  // `fromEntries` defines own properties, so a `__proto__` key cannot set the prototype.
  return Object.fromEntries(entries);
}

function isParamPairSets(value: unknown): value is IsolateParamPair[][] {
  return Array.isArray(value) && value.every((set) => Array.isArray(set) && set.every(isParamPair));
}

function isParamPair(value: unknown): value is IsolateParamPair {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "string" &&
    (typeof value[1] === "string" || value[1] === null)
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
