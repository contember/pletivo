/**
 * `astro:env` in the render isolate. Values travel in the isolate's `env`, never in the
 * module map, so a secret rotation does not recompile the project; the map holds only the
 * names, because ESM exports are static.
 */

/** What the values are called in the isolate's `env`. */
export const ENV_BINDING = "PLETIVO_ENV";

/**
 * The `env` binding that carries `import.meta.env`, which a Loader module lacks.
 * Kept out of the module map because a page may read a secret through it.
 */
export const IMPORT_META_ENV_BINDING = "PLETIVO_IMPORT_META_ENV";

/**
 * The global the rewritten `import.meta.env` reads. A global, because no module can
 * assign to another module's `import.meta`.
 */
export const IMPORT_META_ENV_GLOBAL = "__pletivoImportMetaEnv";

/** The `import.meta.env` values, or `null` when the host supplied none. */
export function importMetaEnvPayload(
  values: Readonly<Record<string, string>> | undefined,
): Record<string, string> | null {
  if (values === undefined) return null;
  const copy = { ...values };
  return Object.keys(copy).length === 0 ? null : copy;
}

/** The installer the generated entry module calls. Not part of the `astro:env` API. */
export const ENV_INSTALL = "__pletivoInstallEnv";

/** Bundle name of the module `astro:env/client` resolves to. */
export const ENV_CLIENT_MODULE_NAME = "pletivo-env-client.js";
/** Bundle name of the module `astro:env/server` resolves to. */
export const ENV_SERVER_MODULE_NAME = "pletivo-env-server.js";

export const ENV_CLIENT_SPECIFIER = "astro:env/client";
export const ENV_SERVER_SPECIFIER = "astro:env/server";

/** The specifiers this host answers to, and the module each becomes. */
export const ENV_MODULES: ReadonlyMap<string, string> = new Map([
  [ENV_CLIENT_SPECIFIER, ENV_CLIENT_MODULE_NAME],
  [ENV_SERVER_SPECIFIER, ENV_SERVER_MODULE_NAME],
]);

/**
 * The values a host hands a render. `astro:env/server` exports both halves (`server`
 * wins on a clash); `astro:env/client` only `client`. Strings only: `env` crosses as JSON.
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
 * Which `astro:env` modules a project imports, and the names it takes from each.
 * `null`: never imported. Empty array: imported without static names (namespace or `import()`).
 */
export interface ProjectEnvUse {
  client: string[] | null;
  server: string[] | null;
}

/** `MAX_DYNAMIC_WORKER_ENV_SIZE`, the platform's cap on a dynamic Worker's `env`. */
export const MAX_ENV_BYTES = 1024 * 1024;

/**
 * The env values exceed a dynamic Worker's `env` cap. Thrown before the Loader is called,
 * which would otherwise fail to start the isolate with no named cause.
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
 * `null` rather than empty objects keeps the isolate cache key unchanged.
 */
export function envPayload(env: ProjectEnv | undefined): EnvPayload | null {
  if (env === undefined) return null;
  const client = { ...env.client };
  const server = { ...env.server };
  if (Object.keys(client).length === 0 && Object.keys(server).length === 0) return null;
  return { client, server };
}

/**
 * Throws when the isolate's `env` would not fit. Measures both payloads together,
 * because the cap is on `env` as a whole.
 */
export function assertEnvFits(
  payload: EnvPayload | null,
  importMetaEnv: Record<string, string> | null = null,
): void {
  if (payload === null && importMetaEnv === null) return;
  const bytes = new TextEncoder().encode(
    JSON.stringify([payload, importMetaEnv]),
  ).byteLength;
  if (bytes > MAX_ENV_BYTES) throw new EnvTooLargeError(bytes);
}

/**
 * The `astro:env` modules this project's bundle needs. Names are the union of what the
 * project imports (an unexported name is a link error) and what the host provided (so a
 * namespace import sees them). Sorted: the module map content-addresses the isolate.
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
 * One generated module: an `export let` live binding per name, set by the installer the
 * entry calls before importing any page. Module-level state is safe here because `env`
 * is fixed per isolate, so every request installs the same values.
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
