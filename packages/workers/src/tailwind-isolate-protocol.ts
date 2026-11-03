/**
 * What the host and the Tailwind isolate exchange. The isolate holds Tailwind and the
 * project's `@plugin` / `@config` modules; everything that changes per page rides here.
 */

import type { ModuleId } from "@pletivo/core/artifact";
import type { TailwindStylesheets } from "./tailwind.ts";

/** Message for a rule no module answers: only a stylesheet outside the `@import` closure has one. */
export function unreachableTailwindModule(hint: "plugin" | "config", specifier: string, stylesheet: string): string {
  return (
    `[pletivo-workers] @${hint} ${JSON.stringify(specifier)} in ${JSON.stringify(stylesheet)} is not in the ` +
    "page's @import closure: the Workers host loads @plugin and @config only from stylesheets a page " +
    "@imports, not through @reference"
  );
}

/** One `@plugin` or `@config` rule and the Loader module holding its bundled target. */
export interface TailwindModuleBinding {
  stylesheet: ModuleId;
  specifier: string;
  executionName: string;
}

export interface TailwindIsolateRequest {
  entry: ModuleId;
  /** `[fileKeyFor(moduleId), text]` for every stylesheet Tailwind may load. */
  files: [string, string][];
  candidates: string[];
  styleTargets: [ModuleId, ModuleId[]][];
  embeddedTargets: [ModuleId, keyof TailwindStylesheets][];
  modules: TailwindModuleBinding[];
}

export interface TailwindIsolateCompiled {
  status: "compiled";
  css: string;
  consumedStylesheets: ModuleId[];
}

export interface TailwindIsolateFailed {
  status: "error";
  message: string;
  stack?: string;
}

export type TailwindIsolateReply = TailwindIsolateCompiled | TailwindIsolateFailed;
