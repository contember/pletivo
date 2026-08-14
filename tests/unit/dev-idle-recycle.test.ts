import { describe, expect, test } from "bun:test";
import { createIdleRecycler, IDLE_RECYCLE_ENV, resolveIdleRecycleMs } from "../../packages/pletivo/src/dev-idle-recycle";

/** Drives the recycler's clock and its check timer by hand, so nothing here waits on real time. */
function harness(thresholdMs: number, checkIntervalMs = 100) {
  let clock = 1_000_000;
  const recycled: number[] = [];
  const recycler = createIdleRecycler({
    thresholdMs,
    checkIntervalMs,
    now: () => clock,
    onRecycle: idleMs => recycled.push(idleMs),
  });
  return {
    recycler,
    recycled,
    advance: (ms: number) => {
      clock += ms;
    },
    /** Let the interval fire as often as the elapsed time allows. */
    tick: async (ms: number) => {
      await Bun.sleep(ms);
    },
  };
}

describe("resolveIdleRecycleMs", () => {
  test("off unless something asks for it", () => {
    expect(resolveIdleRecycleMs(undefined, {})).toBe(0);
  });

  test("config wins", () => {
    expect(resolveIdleRecycleMs(150_000, {})).toBe(150_000);
  });

  test("env applies when config is silent", () => {
    expect(resolveIdleRecycleMs(undefined, { [IDLE_RECYCLE_ENV]: "150000" })).toBe(150_000);
  });

  // A host that sets the env var for every project it spawns must not be able to force the
  // behaviour on a project that has explicitly turned it off.
  test("an explicit zero in config overrides the environment", () => {
    expect(resolveIdleRecycleMs(0, { [IDLE_RECYCLE_ENV]: "150000" })).toBe(0);
  });

  test("junk in the environment is ignored rather than treated as zero delay", () => {
    expect(resolveIdleRecycleMs(undefined, { [IDLE_RECYCLE_ENV]: "soon" })).toBe(0);
    expect(resolveIdleRecycleMs(undefined, { [IDLE_RECYCLE_ENV]: "-5" })).toBe(0);
  });
});

describe("createIdleRecycler", () => {
  test("disabled by a zero threshold, so callers can skip the hooks", () => {
    expect(createIdleRecycler({ thresholdMs: 0, onRecycle: () => {} })).toBeNull();
  });

  // Recycling a server that has served nothing reclaims nothing — it is still at its boot
  // footprint — and on a machine where nobody is working it would restart forever.
  test("a server that never served a request is never recycled", async () => {
    const h = harness(1000);
    h.advance(60_000);
    await h.tick(250);
    expect(h.recycled).toEqual([]);
    h.recycler?.close();
  });

  test("recycles once the idle threshold passes", async () => {
    const h = harness(1000);
    h.recycler?.requestStarted();
    h.recycler?.requestFinished();
    h.advance(1500);
    await h.tick(250);
    expect(h.recycled.length).toBe(1);
    expect(h.recycled[0]).toBeGreaterThanOrEqual(1500);
    h.recycler?.close();
  });

  test("traffic keeps it alive", async () => {
    const h = harness(1000);
    for (let i = 0; i < 4; i++) {
      h.recycler?.requestStarted();
      h.recycler?.requestFinished();
      h.advance(500);
      await h.tick(120);
    }
    expect(h.recycled).toEqual([]);
    h.recycler?.close();
  });

  // The failure this prevents: a first-visit render can take half a minute on a large site.
  // Ageing into the threshold mid-render would kill the request the user is waiting for.
  test("an in-flight request suppresses recycling however long it takes", async () => {
    const h = harness(1000);
    h.recycler?.requestStarted();
    h.advance(60_000);
    await h.tick(250);
    expect(h.recycled).toEqual([]);

    h.recycler?.requestFinished();
    h.advance(1500);
    await h.tick(250);
    expect(h.recycled.length).toBe(1);
    h.recycler?.close();
  });

  // The trigger hands control to a shutdown that runs asynchronously; firing again while the
  // process is on its way out would restart it twice.
  test("fires once, not on every check", async () => {
    const h = harness(1000);
    h.recycler?.requestStarted();
    h.recycler?.requestFinished();
    h.advance(5000);
    await h.tick(500);
    expect(h.recycled.length).toBe(1);
    h.recycler?.close();
  });

  test("stops checking after close", async () => {
    const h = harness(1000);
    h.recycler?.requestStarted();
    h.recycler?.requestFinished();
    h.recycler?.close();
    h.advance(5000);
    await h.tick(250);
    expect(h.recycled).toEqual([]);
  });
});
