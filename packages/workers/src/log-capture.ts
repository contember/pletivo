/**
 * Console output of one isolate request, captured for the host. Runs inside the render
 * isolate, bundled into `pletivo-runtime.js` (it needs `node:async_hooks`), so the
 * AsyncLocalStorage attributes each line to the request that wrote it even when renders
 * overlap. Bounded: an isolate that logs in a loop cannot grow the response unboundedly.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export type LogLevel = "debug" | "log" | "info" | "warn" | "error";

export interface CapturedLog {
  level: LogLevel;
  message: string;
}

export interface CapturedLogs {
  entries: CapturedLog[];
  /** Lines left out once a bound was reached. */
  dropped: number;
}

const LEVELS: readonly LogLevel[] = ["debug", "log", "info", "warn", "error"];
const MAX_ENTRIES = 200;
const MAX_TOTAL_CHARS = 64 * 1024;
const MAX_MESSAGE_CHARS = 4 * 1024;

const current = new AsyncLocalStorage<LogBuffer>();
let installed = false;

class LogBuffer {
  readonly entries: CapturedLog[] = [];
  dropped = 0;
  #chars = 0;

  push(level: LogLevel, parts: readonly unknown[]): void {
    if (this.entries.length >= MAX_ENTRIES || this.#chars >= MAX_TOTAL_CHARS) {
      this.dropped++;
      return;
    }
    let message = parts.map(formatPart).join(" ");
    if (message.length > MAX_MESSAGE_CHARS) message = `${message.slice(0, MAX_MESSAGE_CHARS)}…`;
    this.#chars += message.length;
    this.entries.push({ level, message });
  }
}

/** Patch `console` once per isolate; outside a capture, the original methods run unchanged. */
function install(): void {
  if (installed) return;
  installed = true;
  for (const level of LEVELS) {
    const original = console[level];
    console[level] = (...parts: unknown[]) => {
      current.getStore()?.push(level, parts);
      original.apply(console, parts);
    };
  }
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** Run `operation`, collecting what it logs, and return the logs whether it throws or not. */
export async function runWithLogCapture<T>(
  operation: () => Promise<T>,
): Promise<{ outcome: Outcome<T>; logs: CapturedLogs }> {
  install();
  const buffer = new LogBuffer();
  const outcome = await current.run(buffer, async (): Promise<Outcome<T>> => {
    try {
      return { ok: true, value: await operation() };
    } catch (error) {
      return { ok: false, error };
    }
  });
  return { outcome, logs: { entries: buffer.entries, dropped: buffer.dropped } };
}

function formatPart(part: unknown): string {
  if (typeof part === "string") return part;
  if (part instanceof Error) return part.stack ?? `${part.name}: ${part.message}`;
  if (typeof part === "object" && part !== null) {
    try {
      return JSON.stringify(part);
    } catch {
      return String(part);
    }
  }
  return String(part);
}
