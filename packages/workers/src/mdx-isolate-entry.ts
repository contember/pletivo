/**
 * The MDX isolate's request handling. A remark or rehype plugin runs inside the compile and
 * workerd has no `eval`, so `.mdx` compiles here, next to the project's plugins, and the host
 * links the output into the render program.
 */

import { compileMdxSource, mdxModule } from "@pletivo/core/content/mdx";
import type { MdxIsolateCompiled, MdxIsolateReply, MdxIsolateRequest } from "./mdx-isolate-protocol.ts";
import { pluggable, type IsolatePlugin } from "./portable-plugins.ts";

/** What the generated main module passes: the frozen `config.mdx`, its plugins imported. */
export interface MdxIsolateSettings {
  remarkPlugins: readonly IsolatePlugin[];
  rehypePlugins: readonly IsolatePlugin[];
  gfm: boolean;
  /** `null` outside an Astro project. */
  astro: { pagesDir: string; experimentalHeadingIdCompat: boolean } | null;
}

/** What compiled MDX imports, answered by the host's aliases. */
const JSX_RUNTIME = "pletivo/jsx-runtime";
const MDX_CONTENT = "@pletivo/runtime/mdx-content";

export interface MdxEntry {
  fetch(request: Request): Promise<Response>;
}

export function createMdxEntry(settings: MdxIsolateSettings): MdxEntry {
  const remarkPlugins = settings.remarkPlugins.map(pluggable);
  const rehypePlugins = settings.rehypePlugins.map(pluggable);
  const { astro } = settings;

  async function compile(body: MdxIsolateRequest): Promise<MdxIsolateCompiled> {
    const compiled = await compileMdxSource(body.source, body.file, {
      remarkPlugins,
      rehypePlugins,
      gfm: settings.gfm,
      // No highlighter: the host carries none (docs/todos/016).
      astro: astro === null ? null : { ...astro, highlight: [] },
      // The specifier as written; linking makes it the path the Bun host's compiler writes.
      resolveComponentPath: (specifier) => specifier,
    });
    return {
      status: "compiled",
      code: mdxModule(compiled.code, compiled.exportsComponents, {
        astro: astro !== null,
        jsxRuntime: JSX_RUNTIME,
        mdxContent: MDX_CONTENT,
        label: body.file,
      }),
      componentPaths: compiled.hydrated.map((hydration) => hydration.componentPath),
    };
  }

  return {
    async fetch(request) {
      let reply: MdxIsolateReply;
      try {
        reply = await compile(parseRequest(JSON.parse(await request.text())));
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

function parseRequest(value: unknown): MdxIsolateRequest {
  const file: unknown = typeof value === "object" && value !== null ? Reflect.get(value, "file") : undefined;
  const source: unknown = typeof value === "object" && value !== null ? Reflect.get(value, "source") : undefined;
  if (typeof file !== "string" || typeof source !== "string") {
    throw new Error("MDX isolate request: expected { file: string, source: string }");
  }
  return { file, source };
}
