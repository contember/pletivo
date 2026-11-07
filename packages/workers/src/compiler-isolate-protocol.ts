/**
 * What the host and the compiler isolate exchange: one `transform` or `parse` per request,
 * as JSON, the way `@astrojs/compiler` answers it in-process.
 */

import type {
  DiagnosticMessage,
  HoistedScript,
  HydratedComponent,
  ParseOptions,
  TransformResult,
} from "@astrojs/compiler/types";
import type { AstroTransformOptions } from "./astro-compiler.ts";
import { IsolateProtocolError } from "./isolate-protocol.ts";

export type CompilerIsolateRequest =
  | { op: "transform"; source: string; options: AstroTransformOptions }
  | { op: "parse"; source: string; options: ParseOptions };

export interface CompilerIsolateTransformed {
  status: "transformed";
  result: TransformResult;
}

export interface CompilerIsolateParsed {
  status: "parsed";
  /** The AST as the Go program wrote it; the host parses it once. */
  ast: string;
  diagnostics: DiagnosticMessage[];
}

export interface CompilerIsolateFailed {
  status: "error";
  message: string;
  stack?: string;
}

export type CompilerIsolateReply = CompilerIsolateTransformed | CompilerIsolateParsed | CompilerIsolateFailed;

/** Checked once where it enters the host; the rest of Pletivo reads the typed result. */
export function parseCompilerReply(value: unknown): CompilerIsolateReply {
  const reply = record(value, "$");
  const status = reply.get("status");
  if (status === "transformed") return { status, result: transformResult(reply.get("result"), "$.result") };
  if (status === "parsed") {
    return {
      status,
      ast: string(reply.get("ast"), "$.ast"),
      diagnostics: array(reply.get("diagnostics"), "$.diagnostics", diagnostic),
    };
  }
  if (status === "error") {
    const stack = reply.get("stack");
    return {
      status,
      message: string(reply.get("message"), "$.message"),
      ...(stack === undefined ? {} : { stack: string(stack, "$.stack") }),
    };
  }
  throw new IsolateProtocolError("$.status", "unknown response status");
}

function transformResult(value: unknown, path: string): TransformResult {
  const result = record(value, path);
  return {
    code: string(result.get("code"), `${path}.code`),
    map: string(result.get("map"), `${path}.map`),
    scope: string(result.get("scope"), `${path}.scope`),
    styleError: array(result.get("styleError"), `${path}.styleError`, string),
    diagnostics: array(result.get("diagnostics"), `${path}.diagnostics`, diagnostic),
    css: array(result.get("css"), `${path}.css`, string),
    scripts: array(result.get("scripts"), `${path}.scripts`, hoistedScript),
    hydratedComponents: array(result.get("hydratedComponents"), `${path}.hydratedComponents`, component),
    clientOnlyComponents: array(result.get("clientOnlyComponents"), `${path}.clientOnlyComponents`, component),
    serverComponents: array(result.get("serverComponents"), `${path}.serverComponents`, component),
    containsHead: boolean(result.get("containsHead"), `${path}.containsHead`),
    propagation: boolean(result.get("propagation"), `${path}.propagation`),
  };
}

function hoistedScript(value: unknown, path: string): HoistedScript {
  const script = record(value, path);
  const type = script.get("type");
  if (type === "inline") {
    return { type, code: string(script.get("code"), `${path}.code`), map: string(script.get("map"), `${path}.map`) };
  }
  if (type === "external") return { type, src: string(script.get("src"), `${path}.src`) };
  throw new IsolateProtocolError(`${path}.type`, "expected inline or external");
}

function component(value: unknown, path: string): HydratedComponent {
  const entry = record(value, path);
  return {
    exportName: string(entry.get("exportName"), `${path}.exportName`),
    localName: string(entry.get("localName"), `${path}.localName`),
    specifier: string(entry.get("specifier"), `${path}.specifier`),
    resolvedPath: string(entry.get("resolvedPath"), `${path}.resolvedPath`),
  };
}

function diagnostic(value: unknown, path: string): DiagnosticMessage {
  const entry = record(value, path);
  const location = record(entry.get("location"), `${path}.location`);
  const hint = entry.get("hint");
  return {
    severity: number(entry.get("severity"), `${path}.severity`),
    code: number(entry.get("code"), `${path}.code`),
    location: {
      file: string(location.get("file"), `${path}.location.file`),
      line: number(location.get("line"), `${path}.location.line`),
      column: number(location.get("column"), `${path}.location.column`),
      length: number(location.get("length"), `${path}.location.length`),
    },
    ...(hint === undefined ? {} : { hint: string(hint, `${path}.hint`) }),
    text: string(entry.get("text"), `${path}.text`),
  };
}

function record(value: unknown, path: string): Map<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new IsolateProtocolError(path, "expected an object");
  }
  return new Map(Object.entries(value));
}

function array<T>(value: unknown, path: string, item: (value: unknown, path: string) => T): T[] {
  if (!Array.isArray(value)) throw new IsolateProtocolError(path, "expected an array");
  return value.map((entry, index) => item(entry, `${path}[${index}]`));
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string") throw new IsolateProtocolError(path, "expected a string");
  return value;
}

function number(value: unknown, path: string): number {
  if (typeof value !== "number") throw new IsolateProtocolError(path, "expected a number");
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new IsolateProtocolError(path, "expected a boolean");
  return value;
}
