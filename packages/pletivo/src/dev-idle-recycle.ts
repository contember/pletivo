/**
 * Replace the serving process once it has been idle for a while.
 *
 * A dev server's memory is three layers deep and only one of them comes back. The JS heap
 * plateaus. JSC's arenas (WKFastMalloc) sawtooth — they grow under load and are handed back
 * later. Underneath both sits bun's mimalloc arena (1 GiB reserved up front, committed page
 * by page), which only ever grows: five identical passes over the same 17 pages of a real
 * site moved it 70 → 296 MB while the heap stayed flat. What it retains is live — bun's
 * native caches — plus fragmentation, not unpurged free pages: MIMALLOC_PURGE_DELAY=0 and
 * 64 MiB arenas were both measured and neither returned a megabyte, idle included. A fresh
 * process does, and nothing else does.
 *
 * That matters where several dev servers share one machine — a preview sandbox running one
 * server per editing session — and the sum of their idle footprints is what runs it out of
 * memory, not any single one of them.
 *
 * Two rules keep this from being disruptive:
 *
 *  - Only what a person asked for counts as activity. A forgotten browser tab keeps talking
 *    to the server on its own — see `isHmrTransportPath` — and counting that as "in use"
 *    would mean the server never recycles at all.
 *  - A server that has never served a request is never recycled. It is already at its boot
 *    footprint, so there is nothing to reclaim — and recycling it would loop forever on a
 *    machine where nobody is working.
 */

/** Env override for hosts that spawn `pletivo dev` but do not own the project's config. */
export const IDLE_RECYCLE_ENV = "PLETIVO_DEV_IDLE_RECYCLE_MS";

/**
 * HMR transport, which an open tab drives by itself and which therefore says nothing about
 * whether anyone is there.
 *
 * Two of these would defeat idle detection outright rather than merely blur it: `/__hmr_ping`
 * is a liveness probe on a timer, so every tick would look like fresh traffic, and
 * `/__hmr_poll` deliberately hangs for up to 30s before the client immediately re-issues it,
 * so a request is in flight essentially always. Both fallbacks exist for proxies that break
 * WebSockets, which is exactly the setup a hosted preview sandbox runs behind.
 *
 * Everything else a page pulls in — islands, styles, images — is left counting, because a
 * browser only fetches those when someone loaded a page.
 */
export function isHmrTransportPath(pathname: string): boolean {
  return pathname === "/__hmr" || pathname === "/__hmr_ping" || pathname === "/__hmr_sse" || pathname === "/__hmr_poll";
}

/** How often to check. Fine relative to any sane threshold, and costs nothing. */
const DEFAULT_CHECK_INTERVAL_MS = 15_000;

export interface IdleRecycleOptions {
  /** Idle time before the process is replaced. 0 or absent disables it. */
  thresholdMs?: number;
  /** Called when the server has been idle long enough to be replaced. */
  onRecycle: (idleMs: number) => void;
  checkIntervalMs?: number;
  now?: () => number;
}

export interface IdleRecycler {
  /** Call when a request starts. In-flight requests suppress recycling. */
  requestStarted: () => void;
  /** Call when a request finishes, successfully or not. */
  requestFinished: () => void;
  close: () => void;
}

/**
 * Read the threshold from config, falling back to the environment.
 *
 * An explicit `0` in config means "off" and must win over the env var — otherwise a project
 * could not opt out of a setting its host process imposed.
 */
export function resolveIdleRecycleMs(
  configured: number | undefined,
  env: Record<string, string | undefined> = process.env,
): number {
  if (configured !== undefined) return configured > 0 ? configured : 0;
  const raw = env[IDLE_RECYCLE_ENV];
  if (!raw) return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Watch for idleness. Returns null when disabled, so callers can skip the hooks entirely.
 */
export function createIdleRecycler(options: IdleRecycleOptions): IdleRecycler | null {
  const thresholdMs = options.thresholdMs ?? 0;
  if (thresholdMs <= 0) return null;

  const now = options.now ?? (() => Date.now());
  const checkIntervalMs = Math.min(options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS, thresholdMs);

  let lastRequestAt: number | null = null;
  let inFlight = 0;
  let fired = false;

  const timer = setInterval(() => {
    if (fired || inFlight > 0 || lastRequestAt === null) return;
    const idleMs = now() - lastRequestAt;
    if (idleMs < thresholdMs) return;
    fired = true;
    options.onRecycle(idleMs);
  }, checkIntervalMs);
  // The server keeps the process alive; this timer should never be the reason it stays up.
  timer.unref?.();

  return {
    requestStarted: () => {
      inFlight++;
      lastRequestAt = now();
    },
    requestFinished: () => {
      inFlight = Math.max(0, inFlight - 1);
      // Stamp on completion too: a single slow build must not age into the threshold while
      // it is still the most recent thing the server did.
      lastRequestAt = now();
    },
    close: () => clearInterval(timer),
  };
}
