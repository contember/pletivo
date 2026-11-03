/**
 * Compile a page's Tailwind in a Worker Loader isolate, for a stylesheet closure with
 * `@plugin` or `@config`. The program is Tailwind, the entry and the bundled modules,
 * so pages and projects that use the same modules share one isolate.
 */

import type { ModuleId } from "@pletivo/core/artifact";
import { compareStrings } from "@pletivo/core/compare-strings";
import { executionNameForModuleId } from "./artifact.ts";
import { isolateKey, programHash, type ExecutionNamespace, type ProgramHash } from "./execution-identity.ts";
import {
  TAILWIND_ENTRY_MODULE_NAME,
  TAILWIND_ISOLATE_MODULES,
} from "./generated/runtime-modules.ts";
import { IsolateProtocolError } from "./isolate-protocol.ts";
import type { DynamicWorkerCode, WorkerLoaderBinding } from "./render.ts";
import type { TailwindIsolateReply, TailwindIsolateRequest } from "./tailwind-isolate-protocol.ts";
import type { CompileTailwindOptions, TailwindCompilation, TailwindStylesheets } from "./tailwind.ts";

/** Bumped when the request or reply changes, so a stale isolate is never reused. */
const TAILWIND_ISOLATE_ABI = "pletivo-tailwind-v1";
const TAILWIND_MAIN_MODULE_NAME = "pletivo-tailwind-main.js";
const TAILWIND_STYLESHEETS_MODULE_NAME = "pletivo-tailwind-stylesheets.js";
/** Distinct module sets kept per Tailwind build; a host serves a handful. */
const PROGRAM_CACHE_LIMIT = 32;

/** Where the Tailwind isolate runs; the render isolate's settings. */
export interface TailwindIsolateHost {
  loader: WorkerLoaderBinding;
  namespace: ExecutionNamespace;
  compatibilityDate: string;
  compatibilityFlags: readonly string[];
}

/** A `@plugin` or `@config` rule the compile can reach, and its bundled module's source. */
export interface TailwindModuleSource {
  stylesheet: ModuleId;
  specifier: string;
  module: ModuleId;
  source: string;
}

/** Tailwind threw in the isolate, a plugin included. */
export class TailwindIsolateError extends Error {
  constructor(
    message: string,
    readonly isolateStack?: string,
  ) {
    super(message);
    this.name = "TailwindIsolateError";
  }
}

export async function compileTailwindInIsolate(
  options: CompileTailwindOptions,
  /** Stylesheet text by `ProjectFiles` key. */
  files: ReadonlyMap<string, string>,
  modules: readonly TailwindModuleSource[],
  host: TailwindIsolateHost,
): Promise<TailwindCompilation> {
  const program = await tailwindProgram(options.stylesheets, modules);
  const key = await isolateKey({
    programHash: program.hash,
    namespace: host.namespace,
    platform: {
      hostAbi: TAILWIND_ISOLATE_ABI,
      compatibilityDate: host.compatibilityDate,
      compatibilityFlags: host.compatibilityFlags,
    },
    policy: { outbound: "blocked", env: null, importMetaEnv: null },
  });
  const code: DynamicWorkerCode = {
    compatibilityDate: host.compatibilityDate,
    compatibilityFlags: [...host.compatibilityFlags],
    mainModule: TAILWIND_MAIN_MODULE_NAME,
    modules: program.modules,
    // A plugin has no reason to reach the network.
    globalOutbound: null,
  };
  const stub = host.loader.get(key, immutableCode(code));

  const body: TailwindIsolateRequest = {
    entry: options.entry,
    files: [...files],
    candidates: [...options.candidates],
    styleTargets: [...options.styleTargets].map(([importer, targets]): [ModuleId, ModuleId[]] => [importer, [...targets]]),
    embeddedTargets: [...options.embeddedTargets],
    modules: modules.map((use) => ({
      stylesheet: use.stylesheet,
      specifier: use.specifier,
      executionName: executionNameForModuleId(use.module),
    })),
  };
  const response = await stub.getEntrypoint().fetch(
    new Request("http://pletivo.invalid/tailwind", { method: "POST", body: JSON.stringify(body) }),
  );
  if (!response.ok) throw new TailwindIsolateError(`[pletivo-workers] Tailwind isolate failed: ${await response.text()}`);
  let value: unknown;
  try {
    value = await response.json();
  } catch (error) {
    throw new IsolateProtocolError("$", `expected a JSON response: ${error instanceof Error ? error.message : String(error)}`);
  }
  const reply = parseTailwindReply(value);
  if (reply.status === "error") throw new TailwindIsolateError(reply.message, reply.stack);
  return { css: reply.css, consumedStylesheets: reply.consumedStylesheets };
}

interface TailwindProgram {
  modules: Record<string, string>;
  hash: ProgramHash;
}

const programs = new WeakMap<TailwindStylesheets, Map<string, Promise<TailwindProgram>>>();

/**
 * Tailwind, its stylesheets, the entry and the bundled modules. Hashing it reads every byte,
 * so it is built once per module set; the key is their content, not only their ids.
 */
function tailwindProgram(stylesheets: TailwindStylesheets, modules: readonly TailwindModuleSource[]): Promise<TailwindProgram> {
  const sources = new Map<string, string>();
  for (const use of modules) sources.set(executionNameForModuleId(use.module), use.source);
  const bundled = [...sources].sort(([left], [right]) => compareStrings(left, right));
  const cacheKey = bundled.map(([name, source]) => `${name}\0${source}`).join("\0\0");
  let cache = programs.get(stylesheets);
  if (cache === undefined) {
    cache = new Map();
    programs.set(stylesheets, cache);
  }
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  const programModules: Record<string, string> = { ...TAILWIND_ISOLATE_MODULES };
  for (const [name, source] of bundled) programModules[name] = source;
  programModules[TAILWIND_STYLESHEETS_MODULE_NAME] = `export default ${JSON.stringify(stylesheets)};\n`;
  programModules[TAILWIND_MAIN_MODULE_NAME] = [
    `import { createTailwindEntry } from ${JSON.stringify(`./${TAILWIND_ENTRY_MODULE_NAME}`)};`,
    `import stylesheets from ${JSON.stringify(`./${TAILWIND_STYLESHEETS_MODULE_NAME}`)};`,
    "export default createTailwindEntry(stylesheets, {",
    ...bundled.map(([name]) => `  ${JSON.stringify(name)}: () => import(${JSON.stringify(`./${name}`)}),`),
    "});",
    "",
  ].join("\n");
  const program = programHash({ mainModule: TAILWIND_MAIN_MODULE_NAME, modules: programModules }).then((hash) => ({
    modules: programModules,
    hash,
  }));
  if (cache.size >= PROGRAM_CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(cacheKey, program);
  return program;
}

/** Create the Loader callback outside request-owned call frames. */
function immutableCode(code: DynamicWorkerCode): () => DynamicWorkerCode {
  return () => code;
}

/** Checked: the isolate runs third-party plugin code. */
function parseTailwindReply(value: unknown): TailwindIsolateReply {
  if (typeof value !== "object" || value === null) throw new IsolateProtocolError("$", "expected an object");
  const status: unknown = Reflect.get(value, "status");
  if (status === "compiled") {
    const css: unknown = Reflect.get(value, "css");
    const consumed: unknown = Reflect.get(value, "consumedStylesheets");
    if (typeof css !== "string") throw new IsolateProtocolError("$.css", "expected a string");
    if (!isStringArray(consumed)) throw new IsolateProtocolError("$.consumedStylesheets", "expected a string array");
    return { status, css, consumedStylesheets: consumed };
  }
  if (status === "error") {
    const message: unknown = Reflect.get(value, "message");
    const stack: unknown = Reflect.get(value, "stack");
    if (typeof message !== "string") throw new IsolateProtocolError("$.message", "expected a string");
    return { status, message, ...(typeof stack === "string" ? { stack } : {}) };
  }
  throw new IsolateProtocolError("$.status", "unknown response status");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}
