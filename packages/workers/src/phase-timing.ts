import { AsyncLocalStorage } from "node:async_hooks";

/**
 * One phase of a render, in wall milliseconds. On workerd the clock advances only on I/O that leaves
 * the isolate's thread, so there a phase without such I/O reads 0 and its CPU lands in a later phase.
 */
export interface PhaseTiming {
  name: string;
  ms: number;
  /** A count the phase reports, e.g. how many requests its render isolate has served. */
  count?: number;
}

export type PhaseSink = (timing: PhaseTiming) => void;

const sinks = new AsyncLocalStorage<PhaseSink>();

/** Run `operation` with every phase it reaches reported to `sink`. */
export function withPhaseTimings<T>(sink: PhaseSink, operation: () => Promise<T>): Promise<T> {
  return sinks.run(sink, operation);
}

/** Report a phase to the sink of the current operation, if there is one. */
export function recordPhase(timing: PhaseTiming): void {
  sinks.getStore()?.(timing);
}

/** Time `operation` as `name`, also when it fails. */
export async function timePhase<T>(name: string, operation: () => Promise<T>): Promise<T> {
  const sink = sinks.getStore();
  if (sink === undefined) return operation();
  const started = Date.now();
  try {
    return await operation();
  } finally {
    sink({ name, ms: Date.now() - started });
  }
}
