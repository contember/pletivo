/**
 * `astro:env` in the render isolate: where the values come from, and how they get in.
 *
 * On the Bun host `astro-plugin.ts` registers `astro:env/client` and
 * `astro:env/server` as virtual modules and generates a `export const X =
 * process.env["X"] ?? import.meta.env?.["X"] ?? undefined` line per field of the
 * config's `env.schema` — the server module exporting every field, the client module
 * only the `context: "client"` ones. A Worker has no `process.env` and this host never
 * evaluates `astro.config.*`, so both halves of that have to arrive from outside.
 *
 * They arrive the way the content files do: **in `env`, never in the module map.**
 * `env` is a separate capability from `globalOutbound` — a project can read its API
 * token while still being cut off from the network — and keeping the values out of the
 * map is what stops a secret rotation from re-compiling the project. What the map
 * does hold is the *names*, because ESM named exports are static: a module cannot
 * decide at run time what it exports.
 *
 * ## Which names
 *
 * The union of two sets, and both halves earn their place:
 *
 *  - **what the project imports.** `import { API_BASE } from "astro:env/server"` is a
 *    link error if the module does not export `API_BASE` — inside an isolate, which
 *    reports it as a bundle that would not start. Exporting every imported name makes
 *    an unset variable `undefined` instead, which is exactly what the Bun host does
 *    with an unset `process.env` entry.
 *  - **what the host provided.** `import * as env from "astro:env/server"` names
 *    nothing at the import site, so a namespace import would otherwise see an empty
 *    module and silently render a page with no configuration in it.
 *
 * ## Size
 *
 * A dynamic Worker's `env` is capped at `MAX_DYNAMIC_WORKER_ENV_SIZE`, 1 MiB. Over
 * that the Loader refuses the whole isolate, so this module measures the values it is
 * about to send and throws `EnvTooLargeError` first — a named error against the
 * caller's own data, rather than a failure to start whose cause is a guess.
 */

/** What the values are called in the isolate's `env`. */
export const ENV_BINDING = "PLETIVO_ENV";

/** The installer the generated entry module calls. Not part of the `astro:env` API. */
export const ENV_INSTALL = "__pletivoInstallEnv";

/** Bundle name of the module `astro:env/client` resolves to. */
export const ENV_CLIENT_MODULE_NAME = "pletivo-env-client.js";
/** Bundle name of the module `astro:env/server` resolves to. */
export const ENV_SERVER_MODULE_NAME = "pletivo-env-server.js";

export const ENV_CLIENT_SPECIFIER = "astro:env/client";
export const ENV_SERVER_SPECIFIER = "astro:env/server";

/**
 * The specifiers this host answers to, and the module each becomes.
 *
 * Astro's own two, unchanged, so a project written for the Bun host renders here
 * without an edit — the same contract `CONTENT_API_MODULES` keeps for `astro:content`.
 */
export const ENV_MODULES: ReadonlyMap<string, string> = new Map([
  [ENV_CLIENT_SPECIFIER, ENV_CLIENT_MODULE_NAME],
  [ENV_SERVER_SPECIFIER, ENV_SERVER_MODULE_NAME],
]);

/**
 * The values a host hands a render, split the way `astro:env` splits them.
 *
 * `server` is for what only the server may see — an API token — and `client` for what
 * a browser would be allowed to have. `astro:env/server` exports both, which is what
 * the Bun host's generator does; `astro:env/client` exports only `client`. A name in
 * both records takes the `server` value in the server module.
 *
 * Strings only, because this crosses into a dynamic Worker's `env` as JSON. A project
 * that wants a number reads it as text and parses it, the same as it would from
 * `process.env`.
 */
export interface ProjectEnv {
  client?: Readonly<Record<string, string>>;
  server?: Readonly<Record<string, string>>;
}

/** `ProjectEnv` with both halves present — what actually crosses into the isolate. */
export interface EnvPayload {
  client: Record<string, string>;
  server: Record<string, string>;
}

/**
 * Which `astro:env` modules a project reaches for, and the names it takes from each.
 *
 * `null` means the project never imports that module, so the bundle does not carry
 * it. An empty array means it imports it without naming anything statically — a
 * namespace import, or a dynamic `import()`.
 */
export interface ProjectEnvUse {
  client: string[] | null;
  server: string[] | null;
}

/** `MAX_DYNAMIC_WORKER_ENV_SIZE`, the platform's cap on a dynamic Worker's `env`. */
export const MAX_ENV_BYTES = 1024 * 1024;

/**
 * The env values are bigger than a dynamic Worker's `env` may be.
 *
 * Thrown before the Loader is called, so the message names the caller's data and its
 * measured size instead of arriving as an isolate that would not start. Nothing here
 * can shrink it: `env` is a capability channel, not a place to put a payload. A
 * project with a megabyte of configuration wants a binding it can query — the shape
 * `content-files.ts` uses — rather than a copy of it in every isolate.
 */
export class EnvTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(
      `[pletivo-workers] the astro:env values serialize to ${bytes} bytes, and a ` +
        `dynamic Worker's env holds at most ${MAX_ENV_BYTES} ` +
        "(MAX_DYNAMIC_WORKER_ENV_SIZE). Pass the large value over a binding the page " +
        "can call instead — see ContentBinding in content-files.ts.",
    );
    this.name = "EnvTooLargeError";
  }
}

/** An env name that cannot be an ESM export, which is what the isolate needs it to be. */
export class EnvNameError extends Error {
  constructor(readonly envName: string) {
    super(
      `[pletivo-workers] ${JSON.stringify(envName)} cannot be an astro:env name: the ` +
        "isolate exports each one as a JavaScript binding, so it has to be an identifier.",
    );
    this.name = "EnvNameError";
  }
}

/** What a generated module can export, and therefore what a name is allowed to be. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * The values to put in the isolate's `env`, or `null` when there are none.
 *
 * `null` rather than a pair of empty objects on purpose: it keeps a project that
 * imports `astro:env` but was given nothing out of the isolate cache key, so it goes
 * on sharing one isolate with every other render of the same sources.
 */
export function envPayload(env: ProjectEnv | undefined): EnvPayload | null {
  if (env === undefined) return null;
  const client = { ...env.client };
  const server = { ...env.server };
  if (Object.keys(client).length === 0 && Object.keys(server).length === 0) return null;
  return { client, server };
}

/** Throws when the payload would not fit a dynamic Worker's `env`. */
export function assertEnvFits(payload: EnvPayload | null): void {
  if (payload === null) return;
  const bytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
  if (bytes > MAX_ENV_BYTES) throw new EnvTooLargeError(bytes);
}

/**
 * The `astro:env` modules this project's bundle needs.
 *
 * Sorted, so the bundle a given project and a given set of names produce is the same
 * bundle every time — the module map is what the isolate is content-addressed by.
 */
export function envModules(
  use: ProjectEnvUse,
  payload: EnvPayload | null,
): Record<string, string> {
  const modules: Record<string, string> = {};
  if (use.client !== null) {
    modules[ENV_CLIENT_MODULE_NAME] = envModule("client", [
      ...use.client,
      ...Object.keys(payload?.client ?? {}),
    ]);
  }
  if (use.server !== null) {
    modules[ENV_SERVER_MODULE_NAME] = envModule("server", [
      ...use.server,
      ...Object.keys(payload?.client ?? {}),
      ...Object.keys(payload?.server ?? {}),
    ]);
  }
  return modules;
}

/**
 * One generated module: a live binding per name, and the installer the entry calls.
 *
 * `export let` rather than `export const` because the values are not known when the
 * module is evaluated — they come out of the isolate's `env`, which only the entry's
 * `fetch` can see. ESM live bindings mean an importer reads the installed value, and
 * the entry installs before it imports any page.
 *
 * Reinstalling on every request is a no-op by construction: `env` is fixed when the
 * isolate is created, so every request in that isolate installs the same values. That
 * is what makes module-level state safe here and not for content, where the bytes
 * belong to one request and a mutable global handed them to the wrong one.
 */
function envModule(context: "client" | "server", names: string[]): string {
  const unique = [...new Set(names)].sort();
  for (const name of unique) if (!IDENTIFIER.test(name)) throw new EnvNameError(name);
  const declarations = unique.map((name) => `export let ${name};`).join("\n");
  const assignments = unique
    .map((name) =>
      context === "client"
        ? `  ${name} = client[${JSON.stringify(name)}];`
        : `  ${name} = ${JSON.stringify(name)} in server ? server[${JSON.stringify(name)}] : client[${JSON.stringify(name)}];`,
    )
    .join("\n");
  return `// astro:env/${context}, generated for this project. Values arrive in the isolate's
// own \`env\` and are installed before any page module is imported.
${declarations}${declarations ? "\n" : ""}
export function ${ENV_INSTALL}(values) {
  const client = values.client ?? {};
${context === "server" ? "  const server = values.server ?? {};\n" : ""}${assignments}${assignments ? "\n" : ""}}
`;
}
