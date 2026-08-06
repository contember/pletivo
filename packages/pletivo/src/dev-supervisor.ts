/**
 * Parent process for `pletivo dev`: runs the real dev server as a child and
 * brings it back when it goes away.
 *
 * Two reasons the child goes away:
 *
 *  - It asked to be replaced (`RESTART_EXIT_CODE`) because a config file
 *    changed. The astro host is built once per process and Bun plugins cannot
 *    be unregistered, so re-reading the config in place is not on the table —
 *    a fresh process is the only honest way to apply it.
 *  - It crashed. A dev server that dies at 2am on an unhandled error is worse
 *    than one that comes back, so those get a backed-off retry too. The retry
 *    budget is deliberately small: once it is spent the parent exits with the
 *    child's code, which is what an external supervisor needs to see in order
 *    to take over.
 */

import path from "path";

/** Child asks for a restart with this code. Chosen for EX_TEMPFAIL. */
export const RESTART_EXIT_CODE = 75;

/** Set on the child so it runs the server instead of supervising again. */
export const CHILD_ENV_FLAG = "PLETIVO_DEV_CHILD";

/** Consecutive crashes tolerated before the parent gives up. */
const MAX_CRASH_RETRIES = 5;
const CRASH_BACKOFF_MS = [500, 1000, 2000, 4000, 8000];
/** Let the listening socket go before the replacement binds the same port. */
const RESPAWN_DELAY_MS = 200;
/** A child that ran at least this long is treated as healthy — budget resets. */
const HEALTHY_UPTIME_MS = 10_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface SupervisorOptions {
  /** argv for the child, minus the runtime — defaults to this process's own. */
  argv?: string[];
  /** Consecutive crashes tolerated before giving up. */
  maxCrashRetries?: number;
  /** Delay per consecutive crash; the last entry repeats. */
  backoffMs?: number[];
  /** Pause before a replacement binds the port the child just released. */
  respawnDelayMs?: number;
  now?: () => number;
}

/**
 * Run the dev server under supervision. Resolves with the exit code the parent
 * should terminate with.
 */
export async function superviseDev(options: SupervisorOptions = {}): Promise<number> {
  const argv = options.argv ?? process.argv.slice(1);
  const now = options.now ?? (() => Date.now());
  const maxCrashRetries = options.maxCrashRetries ?? MAX_CRASH_RETRIES;
  const backoffMs = options.backoffMs ?? CRASH_BACKOFF_MS;
  const respawnDelayMs = options.respawnDelayMs ?? RESPAWN_DELAY_MS;

  let crashes = 0;
  let current: ReturnType<typeof Bun.spawn> | null = null;
  let stopping = false;

  const forward = (signal: NodeJS.Signals) => {
    stopping = true;
    current?.kill(signal);
  };
  const onSigint = () => forward("SIGINT");
  const onSigterm = () => forward("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  try {
    for (;;) {
      const startedAt = now();
      current = Bun.spawn([process.execPath, ...argv], {
        cwd: process.cwd(),
        env: { ...process.env, [CHILD_ENV_FLAG]: "1" },
        stdio: ["inherit", "inherit", "inherit"],
      });

      const code = await current.exited;
      current = null;
      if (stopping) return 0;

      if (code === RESTART_EXIT_CODE) {
        crashes = 0;
        await sleep(respawnDelayMs);
        continue;
      }

      if (code === 0) return 0;

      // A child that stayed up a while and then died is a fresh problem, not a
      // continuation of a boot loop.
      if (now() - startedAt >= HEALTHY_UPTIME_MS) crashes = 0;

      if (crashes >= maxCrashRetries) {
        console.error(
          `\n  pletivo dev exited with code ${code} — ${maxCrashRetries} restarts did not help, giving up.\n`,
        );
        return code;
      }

      const delay = backoffMs[Math.min(crashes, backoffMs.length - 1)] ?? 0;
      crashes++;
      console.error(
        `  pletivo dev exited with code ${code} — restarting in ${delay}ms (${crashes}/${maxCrashRetries})`,
      );
      await sleep(delay);
    }
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
}

/** True when this process is the supervised child and must serve, not supervise. */
export function isSupervisedChild(): boolean {
  return process.env[CHILD_ENV_FLAG] === "1";
}

/** Human-readable name for a restart trigger, relative to the project root. */
export function describeConfigChange(projectRoot: string, file: string): string {
  const rel = path.relative(projectRoot, file);
  return rel && !rel.startsWith("..") ? rel : file;
}
