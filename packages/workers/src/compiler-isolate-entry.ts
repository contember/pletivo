/**
 * The compiler isolate's request handling: `@astrojs/compiler` behind `fetch`, so a host
 * that compiles here never instantiates the Go wasm, whose memory only grows, in its own
 * isolate.
 */

import type { ParseOptions } from "@astrojs/compiler/types";
import { createAstroCompiler, goTransformOptions, rawApi } from "./astro-compiler.ts";
import { BoundedLru } from "./bounded-lru.ts";
import type { CompilerIsolateParsed, CompilerIsolateReply, CompilerIsolateRequest } from "./compiler-isolate-protocol.ts";
import { digest } from "./execution-identity.ts";

/**
 * Parses kept by source and options. A host that parses every component again whenever its own
 * caches start over (an editor's host restarting) asks for the same parses; the Go wasm takes
 * milliseconds per file, a kept answer none. The isolate is keyed by the wasm, so a kept parse
 * is always this compiler's.
 */
const PARSE_CACHE_BOUNDS = { maxEntries: 4_000, maxBytes: 24 * 1024 * 1024 };

export interface CompilerEntry {
  fetch(request: Request): Promise<Response>;
}

export function createCompilerEntry(wasm: WebAssembly.Module): CompilerEntry {
  const compiler = createAstroCompiler(wasm);
  const parses = new BoundedLru<CompilerIsolateParsed>(PARSE_CACHE_BOUNDS);

  async function parse(source: string, options: ParseOptions): Promise<CompilerIsolateParsed> {
    const key = await digest(JSON.stringify([options, source]));
    const kept = parses.get(key);
    if (kept !== undefined) return kept;
    // The AST crosses as the Go program's JSON text; parsing it here only to serialize it again is waste.
    const parsed = rawApi(wasm).parse(source, options);
    const reply: CompilerIsolateParsed = { status: "parsed", ast: parsed.ast, diagnostics: parsed.diagnostics };
    parses.set(key, reply, (reply.ast.length + JSON.stringify(reply.diagnostics).length) * 2);
    return reply;
  }

  async function handle(body: CompilerIsolateRequest): Promise<CompilerIsolateReply> {
    if (body.op === "transform") return { status: "transformed", result: await compiler.transform(body.source, goTransformOptions(body.options)) };
    return parse(body.source, body.options);
  }

  return {
    async fetch(request) {
      let reply: CompilerIsolateReply;
      try {
        const body: CompilerIsolateRequest = JSON.parse(await request.text());
        reply = await handle(body);
      } catch (error) {
        // A payload, not a throw: across the Loader boundary a throw reads as a failed start.
        reply = {
          status: "error",
          message: error instanceof Error ? error.message : String(error),
          ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
        };
      }
      return Response.json(reply);
    },
  };
}
