export const ISOLATE_PROTOCOL_VERSION = 1;

/** Null preserves a route param whose value was `undefined` before JSON encoding. */
export type IsolateParamPair = [name: string, value: string | null];

export interface IsolateRouteSegment {
  type: "static" | "param" | "rest";
  value: string;
}

export interface IsolateRoute {
  file: string;
  segments: IsolateRouteSegment[];
  isDynamic: boolean;
  priority: number;
  isEndpoint: boolean;
}

export interface IsolatePathRoute {
  file: string;
  route: IsolateRoute;
}

interface IsolateRequestBase {
  protocol: typeof ISOLATE_PROTOCOL_VERSION;
  contentRef?: string;
  rootDir?: string;
}

export interface IsolateRenderRequest extends IsolateRequestBase {
  op: "render";
  file: string;
  params: IsolateParamPair[];
  route: IsolateRoute | null;
  url: string;
  site?: string;
}

export interface IsolatePathsRequest extends IsolateRequestBase {
  op: "paths";
  routes: IsolatePathRoute[];
}

export type IsolateRequest = IsolateRenderRequest | IsolatePathsRequest;

interface IsolateResponseBase {
  protocol: typeof ISOLATE_PROTOCOL_VERSION;
}

export interface IsolateRenderedResponse extends IsolateResponseBase {
  status: "rendered";
  html: string;
  renderedModules: string[];
  tsxStyles: string[];
}

export type IsolateUnresolvedReason = "no-static-path" | "not-enumerable";

export interface IsolateUnresolvedResponse extends IsolateResponseBase {
  status: "unresolved";
  reason: IsolateUnresolvedReason;
}

export interface IsolatePathsResponse extends IsolateResponseBase {
  status: "paths";
  paths: Record<string, IsolateParamPair[][]>;
}

export interface IsolateErrorResponse extends IsolateResponseBase {
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

export class IsolateProtocolVersionError extends IsolateProtocolError {
  constructor(readonly found: number) {
    super("$.protocol", `expected version ${ISOLATE_PROTOCOL_VERSION}, found ${found}`);
    this.name = "IsolateProtocolVersionError";
  }
}

export function parseIsolateRequest(value: unknown): IsolateRequest {
  const request = requireObject(value, "$");
  parseProtocol(request);
  const op = requiredField(request, "op", "$");
  if (op === "render") return parseRenderRequest(request);
  if (op === "paths") return parsePathsRequest(request);
  throw new IsolateProtocolError("$.op", 'expected "render" or "paths"');
}

export function parseIsolateResponse(value: unknown): IsolateResponse {
  const response = requireObject(value, "$");
  parseProtocol(response);
  const status = requiredField(response, "status", "$");
  if (status === "rendered") return parseRenderedResponse(response);
  if (status === "unresolved") return parseUnresolvedResponse(response);
  if (status === "paths") return parsePathsResponse(response);
  if (status === "error") return parseErrorResponse(response);
  throw new IsolateProtocolError("$.status", "unknown response status");
}

function parseRenderRequest(request: object): IsolateRenderRequest {
  assertFields(
    request,
    ["protocol", "op", "file", "params", "route", "url"],
    ["site", "contentRef", "rootDir"],
    "$",
  );
  const file = requireNonEmptyString(requiredField(request, "file", "$"), "$.file");
  const params = parseParamPairs(requiredField(request, "params", "$"), "$.params");
  const routeValue = requiredField(request, "route", "$");
  const route = routeValue === null ? null : parseRoute(routeValue, "$.route");
  const url = requireNonEmptyString(requiredField(request, "url", "$"), "$.url");
  const site = optionalNonEmptyString(request, "site", "$.site");
  const content = parseContentFields(request);
  return {
    protocol: ISOLATE_PROTOCOL_VERSION,
    op: "render",
    file,
    params,
    route,
    url,
    ...(site === undefined ? {} : { site }),
    ...(content === null ? {} : content),
  };
}

function parsePathsRequest(request: object): IsolatePathsRequest {
  assertFields(
    request,
    ["protocol", "op", "routes"],
    ["contentRef", "rootDir"],
    "$",
  );
  const routes = parsePathRoutes(requiredField(request, "routes", "$"));
  const content = parseContentFields(request);
  return {
    protocol: ISOLATE_PROTOCOL_VERSION,
    op: "paths",
    routes,
    ...(content === null ? {} : content),
  };
}

function parseRenderedResponse(response: object): IsolateRenderedResponse {
  assertFields(
    response,
    ["protocol", "status", "html", "renderedModules", "tsxStyles"],
    [],
    "$",
  );
  const html = requiredField(response, "html", "$");
  if (typeof html !== "string") throw new IsolateProtocolError("$.html", "expected a string");
  return {
    protocol: ISOLATE_PROTOCOL_VERSION,
    status: "rendered",
    html,
    renderedModules: parseStringArray(
      requiredField(response, "renderedModules", "$"),
      "$.renderedModules",
    ),
    tsxStyles: parseStringArray(requiredField(response, "tsxStyles", "$"), "$.tsxStyles"),
  };
}

function parseUnresolvedResponse(response: object): IsolateUnresolvedResponse {
  assertFields(response, ["protocol", "status", "reason"], [], "$");
  const reason = requiredField(response, "reason", "$");
  if (reason !== "no-static-path" && reason !== "not-enumerable") {
    throw new IsolateProtocolError("$.reason", "unknown unresolved reason");
  }
  return { protocol: ISOLATE_PROTOCOL_VERSION, status: "unresolved", reason };
}

function parsePathsResponse(response: object): IsolatePathsResponse {
  assertFields(response, ["protocol", "status", "paths"], [], "$");
  const value = requireObject(requiredField(response, "paths", "$"), "$.paths");
  const paths: Record<string, IsolateParamPair[][]> = {};
  for (const [file, setsValue] of Object.entries(value)) {
    requireNonEmptyString(file, "$.paths key");
    if (file === "__proto__" || file === "prototype" || file === "constructor") {
      throw new IsolateProtocolError(`$.paths.${file}`, "reserved project file key");
    }
    if (!Array.isArray(setsValue)) {
      throw new IsolateProtocolError(`$.paths.${file}`, "expected an array");
    }
    const sets: IsolateParamPair[][] = [];
    for (let index = 0; index < setsValue.length; index++) {
      if (!hasOwn(setsValue, index)) {
        throw new IsolateProtocolError(`$.paths.${file}[${index}]`, "sparse entry");
      }
      sets.push(parseParamPairs(setsValue[index], `$.paths.${file}[${index}]`));
    }
    paths[file] = sets;
  }
  return { protocol: ISOLATE_PROTOCOL_VERSION, status: "paths", paths };
}

function parseErrorResponse(response: object): IsolateErrorResponse {
  assertFields(response, ["protocol", "status", "message"], ["stack"], "$");
  const message = requireNonEmptyString(requiredField(response, "message", "$"), "$.message");
  const stack = optionalNonEmptyString(response, "stack", "$.stack");
  return {
    protocol: ISOLATE_PROTOCOL_VERSION,
    status: "error",
    message,
    ...(stack === undefined ? {} : { stack }),
  };
}

function parsePathRoutes(value: unknown): IsolatePathRoute[] {
  if (!Array.isArray(value)) throw new IsolateProtocolError("$.routes", "expected an array");
  const routes: IsolatePathRoute[] = [];
  for (let index = 0; index < value.length; index++) {
    const path = `$.routes[${index}]`;
    if (!hasOwn(value, index)) throw new IsolateProtocolError(path, "sparse entry");
    const entry = requireObject(value[index], path);
    assertFields(entry, ["file", "route"], [], path);
    routes.push({
      file: requireNonEmptyString(requiredField(entry, "file", path), `${path}.file`),
      route: parseRoute(requiredField(entry, "route", path), `${path}.route`),
    });
  }
  return routes;
}

function parseRoute(value: unknown, path: string): IsolateRoute {
  const route = requireObject(value, path);
  assertFields(
    route,
    ["file", "segments", "isDynamic", "priority", "isEndpoint"],
    [],
    path,
  );
  const segmentsValue = requiredField(route, "segments", path);
  if (!Array.isArray(segmentsValue)) {
    throw new IsolateProtocolError(`${path}.segments`, "expected an array");
  }
  const segments: IsolateRouteSegment[] = [];
  for (let index = 0; index < segmentsValue.length; index++) {
    const segmentPath = `${path}.segments[${index}]`;
    if (!hasOwn(segmentsValue, index)) throw new IsolateProtocolError(segmentPath, "sparse entry");
    const segment = requireObject(segmentsValue[index], segmentPath);
    assertFields(segment, ["type", "value"], [], segmentPath);
    const type = requiredField(segment, "type", segmentPath);
    if (type !== "static" && type !== "param" && type !== "rest") {
      throw new IsolateProtocolError(`${segmentPath}.type`, "unknown route segment type");
    }
    segments.push({
      type,
      value: requireNonEmptyString(
        requiredField(segment, "value", segmentPath),
        `${segmentPath}.value`,
      ),
    });
  }
  const isDynamic = requireBoolean(requiredField(route, "isDynamic", path), `${path}.isDynamic`);
  const priority = requiredField(route, "priority", path);
  if (typeof priority !== "number" || !Number.isFinite(priority)) {
    throw new IsolateProtocolError(`${path}.priority`, "expected a finite number");
  }
  const isEndpoint = requireBoolean(requiredField(route, "isEndpoint", path), `${path}.isEndpoint`);
  return {
    file: requireNonEmptyString(requiredField(route, "file", path), `${path}.file`),
    segments,
    isDynamic,
    priority,
    isEndpoint,
  };
}

function parseParamPairs(value: unknown, path: string): IsolateParamPair[] {
  if (!Array.isArray(value)) throw new IsolateProtocolError(path, "expected an array");
  const pairs: IsolateParamPair[] = [];
  const names = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const pairPath = `${path}[${index}]`;
    if (!hasOwn(value, index)) throw new IsolateProtocolError(pairPath, "sparse entry");
    const pair = value[index];
    if (!Array.isArray(pair) || pair.length !== 2 || !hasOwn(pair, 0) || !hasOwn(pair, 1)) {
      throw new IsolateProtocolError(pairPath, "expected a two-item parameter pair");
    }
    const name = requireNonEmptyString(pair[0], `${pairPath}[0]`);
    const param = pair[1];
    if (typeof param !== "string" && param !== null) {
      throw new IsolateProtocolError(`${pairPath}[1]`, "expected a string or null");
    }
    if (names.has(name)) throw new IsolateProtocolError(`${pairPath}[0]`, "duplicate parameter");
    names.add(name);
    pairs.push([name, param]);
  }
  return pairs;
}

function parseStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new IsolateProtocolError(path, "expected an array");
  const strings: string[] = [];
  for (let index = 0; index < value.length; index++) {
    if (!hasOwn(value, index)) throw new IsolateProtocolError(`${path}[${index}]`, "sparse entry");
    const entry = value[index];
    if (typeof entry !== "string") {
      throw new IsolateProtocolError(`${path}[${index}]`, "expected a string");
    }
    strings.push(entry);
  }
  return strings;
}

function parseContentFields(value: object): { contentRef: string; rootDir: string } | null {
  const hasRef = hasOwn(value, "contentRef");
  const hasRoot = hasOwn(value, "rootDir");
  if (hasRef !== hasRoot) {
    throw new IsolateProtocolError("$.contentRef", "contentRef and rootDir must appear together");
  }
  if (!hasRef) return null;
  const contentRef = requireNonEmptyString(Reflect.get(value, "contentRef"), "$.contentRef");
  const rootDir = Reflect.get(value, "rootDir");
  if (typeof rootDir !== "string") {
    throw new IsolateProtocolError("$.rootDir", "expected a string");
  }
  return { contentRef, rootDir };
}

function parseProtocol(value: object): void {
  const version = requiredField(value, "protocol", "$");
  if (typeof version !== "number") {
    throw new IsolateProtocolError("$.protocol", "expected a number");
  }
  if (version !== ISOLATE_PROTOCOL_VERSION) throw new IsolateProtocolVersionError(version);
}

function requireObject(value: unknown, path: string): object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new IsolateProtocolError(path, "expected an object");
  }
  return value;
}

function requiredField(value: object, field: string, path: string): unknown {
  if (!hasOwn(value, field)) {
    throw new IsolateProtocolError(`${path}.${field}`, "missing required field");
  }
  return Reflect.get(value, field);
}

function optionalNonEmptyString(value: object, field: string, path: string): string | undefined {
  return hasOwn(value, field) ? requireNonEmptyString(Reflect.get(value, field), path) : undefined;
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new IsolateProtocolError(path, "expected a non-empty string");
  }
  return value;
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new IsolateProtocolError(path, "expected a boolean");
  return value;
}

function assertFields(
  value: object,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): void {
  const permitted = new Set([...required, ...optional]);
  for (const field of Object.keys(value)) {
    if (!permitted.has(field)) throw new IsolateProtocolError(`${path}.${field}`, "unknown field");
  }
  for (const field of required) requiredField(value, field, path);
}

function hasOwn(value: object, field: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, field);
}
