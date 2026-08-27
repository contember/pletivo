/**
 * CLI overrides, applied on top of a loaded `pletivo.config.*`.
 *
 * Kept apart from `cli.ts` because that file's parsing used to run as top-level
 * side effects against the real `process.argv`, which left the whole precedence
 * chain — flag over env over config file — reachable only by booting a server.
 */

import type { PletivoConfig } from "./config";

/** `--flag=value` first, then `--flag value`; a following `--flag` is not a value. */
export function readFlag(argv: readonly string[], names: readonly string[]): string | undefined {
  for (const name of names) {
    const eq = argv.find((a) => a.startsWith(`${name}=`));
    if (eq) return eq.slice(name.length + 1);
    const idx = argv.indexOf(name);
    if (idx !== -1) {
      const next = argv[idx + 1];
      if (next && !next.startsWith("--")) return next;
    }
  }
  return undefined;
}

export function readBoolFlag(argv: readonly string[], names: readonly string[]): boolean {
  return names.some((name) => argv.includes(name));
}

/**
 * `parseInt` used to take whatever followed `--port`, so `--port --host` bound
 * an arbitrary port and printed `http://localhost:NaN`. Refuse it instead.
 */
function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`--port expects a number between 0 and 65535, got ${JSON.stringify(value)}`);
  }
  return port;
}

/** `PLETIVO_STALE=0` and `PLETIVO_STALE=` mean off; any other value means on. */
function envIsTruthy(value: string | undefined): boolean {
  return value !== undefined && value !== "0" && value !== "";
}

export interface CliArgvOptions {
  command: string | undefined;
  incremental: boolean;
  clean: boolean;
  noRestart: boolean;
}

export function readArgvOptions(argv: readonly string[]): CliArgvOptions {
  return {
    command: argv[2],
    incremental: argv.includes("--incremental"),
    clean: argv.includes("--clean"),
    noRestart: argv.includes("--no-restart"),
  };
}

/**
 * Mutates `config` in place, the way the CLI has always done — `loadConfig()`
 * hands over a fresh object per process. `argv` is the full `process.argv`,
 * so indices line up with what the shell passed.
 */
export function applyCliOverrides(
  config: PletivoConfig,
  argv: readonly string[],
  env: Record<string, string | undefined>,
): PletivoConfig {
  const command = argv[2];

  const port = readFlag(argv, ["--port"]);
  if (port !== undefined) config.port = parsePort(port);
  // Legacy positional port for `pletivo dev <port>`.
  if (command === "dev" && /^\d+$/.test(argv[3] ?? "")) config.port = parseInt(argv[3], 10);

  const host = readFlag(argv, ["--host"]);
  if (host !== undefined) config.host = host;
  // A bare `--host`, or one followed by another flag, means "every interface".
  else if (argv.includes("--host")) config.host = "0.0.0.0";

  const notFoundPage = readFlag(argv, ["--404-page", "--not-found-page"]);
  if (notFoundPage) config.notFoundPage = notFoundPage;
  else if (env.PLETIVO_404_PAGE) config.notFoundPage = env.PLETIVO_404_PAGE;

  // Dev hybrid options. Merge on top of whatever came from the config file.
  const errorPage = readFlag(argv, ["--error-page"]);
  const stale = readBoolFlag(argv, ["--stale"]);
  const debugHeader = readFlag(argv, ["--debug-header"]);
  if (errorPage || stale || debugHeader ||
      env.PLETIVO_ERROR_PAGE || env.PLETIVO_STALE || env.PLETIVO_DEBUG_HEADER) {
    config.dev = { ...config.dev };
    if (errorPage) config.dev.errorPage = errorPage;
    else if (env.PLETIVO_ERROR_PAGE) config.dev.errorPage = env.PLETIVO_ERROR_PAGE;
    if (stale) config.dev.stale = true;
    else if (envIsTruthy(env.PLETIVO_STALE)) config.dev.stale = true;
    if (debugHeader) config.dev.debugHeader = debugHeader;
    else if (env.PLETIVO_DEBUG_HEADER) config.dev.debugHeader = env.PLETIVO_DEBUG_HEADER;
  }

  return config;
}
