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

/**
 * Receives each phase as it ends. It must not throw: it is called inside the operation, so its
 * error would replace the operation's result or error.
 */
export type PhaseSink = (timing: PhaseTiming) => void;

/**
 * Runs a phase inside a span of the host's tracer, e.g. Workers' `tracing.enterSpan`, so a trace shows
 * the phase around the I/O it does. It must return what `operation` returns and settle as it settles.
 * A span has the same clock as `PhaseTiming`: a phase without I/O spans 0 ms.
 */
export type PhaseSpan = <T>(name: string, operation: () => Promise<T>) => Promise<T>;

interface PhaseContext {
  sink: PhaseSink;
  span: PhaseSpan | undefined;
}

const contexts = new AsyncLocalStorage<PhaseContext>();

/** Run `operation` with every phase it reaches reported to `sink`, and run inside `span` if given. */
export function withPhaseTimings<T>(sink: PhaseSink, operation: () => Promise<T>, span?: PhaseSpan): Promise<T> {
  return contexts.run({ sink, span }, operation);
}

/** Report a phase to the sink of the current operation, if there is one. */
export function recordPhase(timing: PhaseTiming): void {
  contexts.getStore()?.sink(timing);
}

/** Time `operation` as `name`, also when it fails. */
export async function timePhase<T>(name: string, operation: () => Promise<T>): Promise<T> {
  const context = contexts.getStore();
  if (context === undefined) return operation();
  const started = Date.now();
  try {
    return await (context.span === undefined ? operation() : context.span(name, operation));
  } finally {
    context.sink({ name, ms: Date.now() - started });
  }
}
