/**
 * Compile `.mdx` in a Worker Loader isolate: a remark or rehype plugin runs inside the compile,
 * and the host cannot evaluate one. The program is the MDX entry, the artifact's frozen
 * `config.mdx` and its plugins' modules, so every page and every edit of a project shares one
 * isolate, and the compile stays live.
 */

import type { ArtifactMdxConfig } from "@pletivo/core/artifact";
import type { ProjectArtifact } from "./artifact.ts";
import type { AstroCompiler } from "./astro-compiler.ts";
import { compilePluginProgram } from "./compile-project.ts";
import { UnsupportedFileError } from "./compile/source-module.ts";
import type { CompiledMdxModule, MdxCompiler } from "./compile/types.ts";
import type { ProgramMarkdownPlugin } from "./compiled-program.ts";
import { isolateKey, programHash, type ExecutionNamespace, type ProgramHash } from "./execution-identity.ts";
import { MDX_ENTRY_MODULE_NAME, MDX_ISOLATE_MODULES } from "./generated/runtime-modules.ts";
import { IsolateProtocolError } from "./isolate-protocol.ts";
import type { MdxIsolateReply, MdxIsolateRequest } from "./mdx-isolate-protocol.ts";
import type { DynamicWorkerCode, WorkerLoaderBinding } from "./render.ts";

/** Bumped when the request, the reply or the settings change, so a stale isolate is never reused. */
const MDX_ISOLATE_ABI = "pletivo-mdx-v1";
const MDX_MAIN_MODULE_NAME = "pletivo-mdx-main.js";

/** Where the MDX isolate runs; the render isolate's settings. */
export interface MdxIsolateHost {
  loader: WorkerLoaderBinding;
  namespace: ExecutionNamespace;
  compatibilityDate: string;
  compatibilityFlags: readonly string[];
}

export interface IsolateMdxCompilerOptions {
  host: MdxIsolateHost;
  /** Absent: a project prepared by nothing compiles with `@astrojs/mdx`'s defaults outside Astro. */
  artifact: ProjectArtifact | undefined;
  /** Where pages live in the file map: an Astro page gets its charset only there. */
  pagesDir: string;
  /** Links the plugins' artifact modules, which hold no `.astro` file. */
  compiler: AstroCompiler;
}

/** The compile threw in the isolate, a plugin's included, or the isolate failed. */
export class MdxIsolateError extends UnsupportedFileError {
  constructor(
    file: string,
    reason: string,
    readonly isolateStack?: string,
  ) {
    super(file, reason);
    this.name = "MdxIsolateError";
  }
}

/** An `.mdx` file reached with an artifact prepared before the project had one. */
export class MdxNotPreparedError extends Error {
  constructor() {
    super(
      "[pletivo-workers] the artifact was prepared from a project without .mdx files, so it holds no MDX " +
        "config; re-run `pletivo prepare`",
    );
    this.name = "MdxNotPreparedError";
  }
}

/** A project without an artifact compiles as the Bun host does without an Astro config. */
const DEFAULT_MDX_CONFIG: ArtifactMdxConfig = { remarkPlugins: [], rehypePlugins: [], gfm: true };

interface MdxProgram {
  modules: Record<string, string>;
  hash: ProgramHash;
}

/** Per artifact, then per `pagesDir`. Hashing reads every byte of the plugins, so it is done once. */
const programs = new WeakMap<ProjectArtifact, Map<string, Promise<MdxProgram>>>();
const unprepared = new Map<string, Promise<MdxProgram>>();

export function createIsolateMdxCompiler(options: IsolateMdxCompilerOptions): MdxCompiler {
  const program = (): Promise<MdxProgram> => mdxProgram(options);
  return {
    async identity() {
      return (await program()).hash;
    },
    async compile(file, source) {
      return compileInIsolate(await program(), options.host, file, source);
    },
  };
}

function mdxProgram(options: IsolateMdxCompilerOptions): Promise<MdxProgram> {
  const { artifact, pagesDir } = options;
  let cache = unprepared;
  if (artifact !== undefined) {
    cache = programs.get(artifact) ?? new Map<string, Promise<MdxProgram>>();
    programs.set(artifact, cache);
  }
  const cached = cache.get(pagesDir);
  if (cached !== undefined) return cached;
  const program = buildProgram(options);
  cache.set(pagesDir, program);
  // A failed build is not kept: the next compile builds the program again.
  program.catch(() => {
    if (cache.get(pagesDir) === program) cache.delete(pagesDir);
  });
  return program;
}

async function buildProgram({ artifact, pagesDir, compiler }: IsolateMdxCompilerOptions): Promise<MdxProgram> {
  const config = artifact === undefined ? DEFAULT_MDX_CONFIG : artifact.prepared.artifact.config.mdx;
  if (config === undefined) throw new MdxNotPreparedError();
  const plugins = artifact === undefined
    ? { modules: {}, remarkPlugins: [], rehypePlugins: [] }
    : await compilePluginProgram(artifact, compiler, config);
  const imports = new Map<string, string>();
  const list = (entries: readonly ProgramMarkdownPlugin[]): string =>
    `[${entries.map((entry) => {
      let local = imports.get(entry.executionName);
      if (local === undefined) {
        local = `$$plugin${imports.size}`;
        imports.set(entry.executionName, local);
      }
      const pluginOptions = entry.options === undefined ? "" : `, options: ${JSON.stringify(entry.options)}`;
      return `{ module: ${local}, exportName: ${JSON.stringify(entry.exportName)}${pluginOptions} }`;
    }).join(", ")}]`;
  const remarkPlugins = list(plugins.remarkPlugins);
  const rehypePlugins = list(plugins.rehypePlugins);
  const astro = config.astro === undefined
    ? null
    : { pagesDir, experimentalHeadingIdCompat: config.astro.experimentalHeadingIdCompat };
  const main = [
    ...[...imports].map(([name, local]) => `import * as ${local} from ${JSON.stringify(`./${name}`)};`),
    `import { createMdxEntry } from ${JSON.stringify(`./${MDX_ENTRY_MODULE_NAME}`)};`,
    `export default createMdxEntry({ remarkPlugins: ${remarkPlugins}, rehypePlugins: ${rehypePlugins}, ` +
      `gfm: ${JSON.stringify(config.gfm)}, astro: ${JSON.stringify(astro)} });`,
    "",
  ].join("\n");
  const modules = { ...plugins.modules, ...MDX_ISOLATE_MODULES, [MDX_MAIN_MODULE_NAME]: main };
  return { modules, hash: await programHash({ mainModule: MDX_MAIN_MODULE_NAME, modules }) };
}

async function compileInIsolate(program: MdxProgram, host: MdxIsolateHost, file: string, source: string): Promise<CompiledMdxModule> {
  const key = await isolateKey({
    programHash: program.hash,
    namespace: host.namespace,
    platform: {
      hostAbi: MDX_ISOLATE_ABI,
      compatibilityDate: host.compatibilityDate,
      compatibilityFlags: host.compatibilityFlags,
    },
    policy: { outbound: "blocked", env: null, importMetaEnv: null },
  });
  const code: DynamicWorkerCode = {
    compatibilityDate: host.compatibilityDate,
    compatibilityFlags: [...host.compatibilityFlags],
    mainModule: MDX_MAIN_MODULE_NAME,
    modules: program.modules,
    // A plugin has no reason to reach the network.
    globalOutbound: null,
  };
  const stub = host.loader.get(key, immutableCode(code));
  const body: MdxIsolateRequest = { file, source };
  const response = await stub.getEntrypoint().fetch(
    new Request("http://pletivo.invalid/mdx", { method: "POST", body: JSON.stringify(body) }),
  );
  if (!response.ok) throw new MdxIsolateError(file, `the MDX isolate failed: ${await response.text()}`);
  let value: unknown;
  try {
    value = await response.json();
  } catch (error) {
    throw new IsolateProtocolError("$", `expected a JSON response: ${error instanceof Error ? error.message : String(error)}`);
  }
  const reply = parseMdxReply(value);
  if (reply.status === "error") throw new MdxIsolateError(file, `MDX compilation failed: ${reply.message}`, reply.stack);
  return { code: reply.code, componentPaths: reply.componentPaths };
}

/** Create the Loader callback outside request-owned call frames. */
function immutableCode(code: DynamicWorkerCode): () => DynamicWorkerCode {
  return () => code;
}

/** Checked: the isolate runs third-party plugin code. */
function parseMdxReply(value: unknown): MdxIsolateReply {
  if (typeof value !== "object" || value === null) throw new IsolateProtocolError("$", "expected an object");
  const status: unknown = Reflect.get(value, "status");
  if (status === "compiled") {
    const code: unknown = Reflect.get(value, "code");
    const componentPaths: unknown = Reflect.get(value, "componentPaths");
    if (typeof code !== "string") throw new IsolateProtocolError("$.code", "expected a string");
    if (!isStringArray(componentPaths)) throw new IsolateProtocolError("$.componentPaths", "expected a string array");
    return { status, code, componentPaths };
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
