import { describe, expect, test } from "bun:test";
import { type PhaseSpan, type PhaseTiming, recordPhase, timePhase, withPhaseTimings } from "../src/phase-timing.ts";

/** A span that records the phases it wraps, in the order they enter and leave. */
function recordingSpan(events: string[]): PhaseSpan {
  return async (name, operation) => {
    events.push(`enter ${name}`);
    try {
      return await operation();
    } finally {
      events.push(`leave ${name}`);
    }
  };
}

describe("phase spans", () => {
  test("a timed phase runs inside the span named after it, nested phases inside their parent", async () => {
    const events: string[] = [];
    const phases: PhaseTiming[] = [];
    const result = await withPhaseTimings(
      (phase) => phases.push(phase),
      () =>
        timePhase("compile", async () => {
          events.push("compile body");
          return timePhase("stylesheet", async () => {
            events.push("stylesheet body");
            return 42;
          });
        }),
      recordingSpan(events),
    );
    expect(result).toBe(42);
    expect(events).toEqual(["enter compile", "compile body", "enter stylesheet", "stylesheet body", "leave stylesheet", "leave compile"]);
    expect(phases.map((phase) => phase.name)).toEqual(["stylesheet", "compile"]);
  });

  test("a failing phase leaves its span with the phase's error and is still timed", async () => {
    const events: string[] = [];
    const phases: PhaseTiming[] = [];
    const failure = new Error("compile failed");
    const run = withPhaseTimings(
      (phase) => phases.push(phase),
      () =>
        timePhase("compile", async () => {
          throw failure;
        }),
      recordingSpan(events),
    );
    await expect(run).rejects.toBe(failure);
    expect(events).toEqual(["enter compile", "leave compile"]);
    expect(phases.map((phase) => phase.name)).toEqual(["compile"]);
  });

  test("without a span, phases are timed as before and a recorded phase opens no span", async () => {
    const phases: PhaseTiming[] = [];
    await withPhaseTimings(
      (phase) => phases.push(phase),
      async () => {
        recordPhase({ name: "isolate-key", ms: 0, count: 3 });
        await timePhase("listing", async () => undefined);
      },
    );
    expect(phases).toEqual([
      { name: "isolate-key", ms: 0, count: 3 },
      { name: "listing", ms: expect.any(Number) },
    ]);
  });

  test("outside withPhaseTimings, a phase runs without a span or a timing", async () => {
    expect(await timePhase("listing", async () => "listed")).toBe("listed");
  });
});
