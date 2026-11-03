/**
 * The Tailwind isolate's request handling. Tailwind calls a `@plugin` or `@config`
 * module synchronously while it compiles, and workerd has no `eval`, so the compile
 * runs here, next to the modules, instead of in the host.
 */

import * as tailwindcss from "tailwindcss";
import {
  unreachableTailwindModule,
  type TailwindIsolateCompiled,
  type TailwindIsolateReply,
  type TailwindIsolateRequest,
} from "./tailwind-isolate-protocol.ts";
import { compileTailwind, tailwindModule, type TailwindStylesheets } from "./tailwind.ts";

/** Loader module name -> its import. The host writes these as literal `import()`s per program. */
export type TailwindModuleImports = Readonly<Record<string, () => Promise<unknown>>>;

export interface TailwindEntry {
  fetch(request: Request): Promise<Response>;
}

export function createTailwindEntry(stylesheets: TailwindStylesheets, imports: TailwindModuleImports): TailwindEntry {
  const tailwind = tailwindModule(tailwindcss);

  async function compile(body: TailwindIsolateRequest): Promise<TailwindIsolateCompiled> {
    const rules = new Map(body.modules.map((binding) => [ruleKey(binding.stylesheet, binding.specifier), binding.executionName]));
    const compilation = await compileTailwind(
      {
        entry: body.entry,
        files: new Map(body.files),
        stylesheets,
        candidates: body.candidates,
        styleTargets: new Map(body.styleTargets),
        embeddedTargets: new Map(body.embeddedTargets),
      },
      {
        tailwind,
        async loadModule(specifier, stylesheet, hint) {
          const name = rules.get(ruleKey(stylesheet, specifier));
          const load = name !== undefined && Object.hasOwn(imports, name) ? imports[name] : undefined;
          if (load === undefined) throw new Error(unreachableTailwindModule(hint, specifier, stylesheet));
          const loaded = await load();
          return typeof loaded === "object" && loaded !== null ? Reflect.get(loaded, "default") : undefined;
        },
      },
    );
    return { status: "compiled", css: compilation.css, consumedStylesheets: [...compilation.consumedStylesheets] };
  }

  return {
    async fetch(request) {
      let reply: TailwindIsolateReply;
      try {
        const body: TailwindIsolateRequest = JSON.parse(await request.text());
        reply = await compile(body);
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

function ruleKey(stylesheet: string, specifier: string): string {
  return `${stylesheet}\0${specifier}`;
}
