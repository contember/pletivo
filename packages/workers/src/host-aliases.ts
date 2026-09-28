import { ASSETS_SPECIFIER, IMAGE_RUNTIME_SPECIFIER } from "./astro-assets.ts";
import {
  ENV_CLIENT_MODULE_NAME,
  ENV_CLIENT_SPECIFIER,
  ENV_SERVER_MODULE_NAME,
  ENV_SERVER_SPECIFIER,
} from "./env.ts";
import { JSX_RUNTIME_MODULE_NAME, RUNTIME_MODULE_NAME } from "./generated/runtime-modules.ts";
import { JSX_IMPORT_SPECIFIER } from "./transpile.ts";

/**
 * Specifiers that name pletivo's content API rather than a project file.
 *
 * The bare ones are what a project writes. `astro:content` and `astro/loaders` are
 * Astro's own and the Bun host already answers to both — `astro-plugin.ts` registers
 * them as Bun virtual modules, for `.tsx` as much as for `.astro` — and
 * `pletivo/content` is the package's own `exports` entry. A project written against
 * either renders on both hosts with nothing changed.
 */
export type HostAlias =
  | { kind: "fixed"; executionName: string }
  | { kind: "content" }
  | { kind: "assets" }
  | { kind: "image" }
  | { kind: "env"; executionName: string };

/**
 * Every supported public spelling converges on one generated singleton module.
 *
 * Its keys are also the only externals an artifact may bind to.
 */
export const HOST_ALIASES: ReadonlyMap<string, HostAlias> = new Map([
  [JSX_IMPORT_SPECIFIER, { kind: "fixed", executionName: JSX_RUNTIME_MODULE_NAME }],
  ["pletivo/jsx-dev-runtime", { kind: "fixed", executionName: JSX_RUNTIME_MODULE_NAME }],
  ["@pletivo/runtime/jsx-runtime", { kind: "fixed", executionName: JSX_RUNTIME_MODULE_NAME }],
  ["pletivo/astro-shim", { kind: "fixed", executionName: RUNTIME_MODULE_NAME }],
  ["@pletivo/runtime/astro-shim", { kind: "fixed", executionName: RUNTIME_MODULE_NAME }],
  ["astro:content", { kind: "content" }],
  ["astro/loaders", { kind: "content" }],
  ["pletivo/content", { kind: "content" }],
  [ASSETS_SPECIFIER, { kind: "assets" }],
  [IMAGE_RUNTIME_SPECIFIER, { kind: "image" }],
  [ENV_CLIENT_SPECIFIER, { kind: "env", executionName: ENV_CLIENT_MODULE_NAME }],
  [ENV_SERVER_SPECIFIER, { kind: "env", executionName: ENV_SERVER_MODULE_NAME }],
]);
