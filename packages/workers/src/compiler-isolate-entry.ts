/**
 * The compiler isolate's request handling: `@astrojs/compiler` behind `fetch`, so a host
 * that compiles here never instantiates the Go wasm, whose memory only grows, in its own
 * isolate.
 */

import { createAstroCompiler, goTransformOptions, rawApi } from "./astro-compiler.ts";
import type { CompilerIsolateReply, CompilerIsolateRequest } from "./compiler-isolate-protocol.ts";

export interface CompilerEntry {
  fetch(request: Request): Promise<Response>;
}

export function createCompilerEntry(wasm: WebAssembly.Module): CompilerEntry {
  const compiler = createAstroCompiler(wasm);

  async function handle(body: CompilerIsolateRequest): Promise<CompilerIsolateReply> {
    if (body.op === "transform") return { status: "transformed", result: await compiler.transform(body.source, goTransformOptions(body.options)) };
    // The AST crosses as the Go program's JSON text; parsing it here only to serialize it again is waste.
    const parsed = rawApi(wasm).parse(body.source, body.options);
    return { status: "parsed", ast: parsed.ast, diagnostics: parsed.diagnostics };
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
