/**
 * The Astro compiler in a Worker Loader isolate of its own. The Go wasm's memory grows to
 * what the largest source needed and never shrinks, so a host whose own isolate is short
 * of memory compiles here. Same answers as `createAstroCompiler`, one `fetch` per call.
 */

import type { ParseOptions, ParseResult, TransformResult } from "@astrojs/compiler/types";
import { astFromJson, type AstroCompiler, type AstroTransformOptions } from "./astro-compiler.ts";
import { parseCompilerReply, type CompilerIsolateReply, type CompilerIsolateRequest } from "./compiler-isolate-protocol.ts";
import { isolateKey, programHash, type ExecutionNamespace, type IsolateKey } from "./execution-identity.ts";
import {
  COMPILER_ISOLATE_MODULES,
  COMPILER_MAIN_MODULE_NAME,
  COMPILER_WASM_MODULE_NAME,
} from "./generated/runtime-modules.ts";
import { IsolateProtocolError } from "./isolate-protocol.ts";
import type { DynamicWorkerCode, WorkerLoaderBinding } from "./render.ts";

/** Bumped when the request or reply changes, so a stale isolate is never reused. */
const COMPILER_ISOLATE_ABI = "pletivo-compiler-v1";

export interface CompilerIsolateOptions {
  loader: WorkerLoaderBinding;
  namespace: ExecutionNamespace;
  compatibilityDate: string;
  compatibilityFlags: readonly string[];
  /** `@astrojs/compiler/astro.wasm`'s bytes; hashed once, and handed over when the Loader creates the isolate. */
  wasm: () => ArrayBuffer | Promise<ArrayBuffer>;
}

/** The compiler threw in the isolate, or answered with an error. */
export class CompilerIsolateError extends Error {
  constructor(
    message: string,
    readonly isolateStack?: string,
  ) {
    super(message);
    this.name = "CompilerIsolateError";
  }
}

export function createIsolateAstroCompiler(options: CompilerIsolateOptions): AstroCompiler {
  let key: Promise<IsolateKey> | undefined;
  const isolateKeyOnce = (): Promise<IsolateKey> => {
    key ??= compilerIsolateKey(options);
    // A failed hash is not kept: the next call tries again.
    key.catch(() => {
      key = undefined;
    });
    return key;
  };

  async function call(request: CompilerIsolateRequest): Promise<CompilerIsolateReply> {
    const stub = options.loader.get(await isolateKeyOnce(), async (): Promise<DynamicWorkerCode> => ({
      compatibilityDate: options.compatibilityDate,
      compatibilityFlags: [...options.compatibilityFlags],
      mainModule: COMPILER_MAIN_MODULE_NAME,
      modules: { ...COMPILER_ISOLATE_MODULES, [COMPILER_WASM_MODULE_NAME]: { wasm: await options.wasm() } },
      // A compiler has no reason to reach the network.
      globalOutbound: null,
    }));
    const response = await stub.getEntrypoint().fetch(
      new Request("http://pletivo.invalid/compile", { method: "POST", body: JSON.stringify(request) }),
    );
    if (!response.ok) throw new CompilerIsolateError(`[pletivo-workers] compiler isolate failed: ${await response.text()}`);
    let value: unknown;
    try {
      value = await response.json();
    } catch (error) {
      throw new IsolateProtocolError("$", `expected a JSON response: ${error instanceof Error ? error.message : String(error)}`);
    }
    const reply = parseCompilerReply(value);
    if (reply.status === "error") throw new CompilerIsolateError(reply.message, reply.stack);
    return reply;
  }

  return {
    async transform(source: string, transformOptions: AstroTransformOptions = {}): Promise<TransformResult> {
      const reply = await call({ op: "transform", source, options: transformOptions });
      if (reply.status !== "transformed") throw new IsolateProtocolError("$.status", "expected transformed");
      return reply.result;
    },
    async parse(source: string, parseOptions: ParseOptions = {}): Promise<ParseResult> {
      const reply = await call({ op: "parse", source, options: parseOptions });
      if (reply.status !== "parsed") throw new IsolateProtocolError("$.status", "expected parsed");
      return { ast: astFromJson(reply.ast), diagnostics: reply.diagnostics };
    },
  };
}

/** The program is the entry and the wasm; the wasm counts by its digest, not its 5 MB of bytes. */
async function compilerIsolateKey(options: CompilerIsolateOptions): Promise<IsolateKey> {
  const wasm = await options.wasm();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", wasm));
  const wasmHash = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return isolateKey({
    programHash: await programHash({
      mainModule: COMPILER_MAIN_MODULE_NAME,
      modules: { ...COMPILER_ISOLATE_MODULES, [COMPILER_WASM_MODULE_NAME]: `sha256:${wasmHash}` },
    }),
    namespace: options.namespace,
    platform: {
      hostAbi: COMPILER_ISOLATE_ABI,
      compatibilityDate: options.compatibilityDate,
      compatibilityFlags: options.compatibilityFlags,
    },
    policy: { outbound: "blocked", env: null, importMetaEnv: null },
  });
}
