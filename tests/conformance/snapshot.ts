/**
 * Snapshot serialization, parsing and diffing.
 *
 * One committed file per corpus entry, holding a `#`-prefixed header followed
 * by sections separated by a marker line. The format is line-oriented so that
 * `git diff` on a snapshot reads as "this page's markup changed", not as one
 * enormous changed line.
 */
import type { CorpusEntry } from "./corpus";

const MARKER_PREFIX = "--- pletivo:conformance ";
const MARKER_SUFFIX = " ---";

/** Section name holding the sorted list of every file the render emitted. */
export const EMITTED_SECTION = "emitted";

export function formatSnapshot(entry: CorpusEntry, sections: Map<string, string>, adapterName: string): string {
  const lines: string[] = [
    `# pletivo conformance snapshot`,
    `# case:    ${entry.id}`,
    `# project: ${entry.root}`,
    `# covers:`,
    ...entry.covers.map((c) => `#   - ${c}`),
    `#`,
    `# Recorded from the "${adapterName}" adapter, but this file is not tied to it:`,
    `# any runtime claiming pletivo rendering parity must reproduce it exactly.`,
    `# Values in [brackets] are normalized — see tests/conformance/normalize.ts.`,
    `#`,
    `# Regenerate:  UPDATE_SNAPSHOTS=1 bun test tests/conformance`,
    `# Just this case:  UPDATE_SNAPSHOTS=1 CONFORMANCE_CASE=${entry.id} bun test tests/conformance`,
  ];
  for (const [name, content] of sections) {
    lines.push("", `${MARKER_PREFIX}${name}${MARKER_SUFFIX}`, content);
  }
  return lines.join("\n") + "\n";
}

export function parseSnapshot(text: string): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = text.split("\n");
  let current: string | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (current === null) return;
    // The writer appends exactly one newline after each section body, so
    // dropping one trailing empty line round-trips content that does and does
    // not end in a newline.
    if (buffer.length && buffer[buffer.length - 1] === "") buffer.pop();
    sections.set(current, buffer.join("\n"));
  };

  for (const line of lines) {
    if (line.startsWith(MARKER_PREFIX) && line.endsWith(MARKER_SUFFIX)) {
      flush();
      current = line.slice(MARKER_PREFIX.length, line.length - MARKER_SUFFIX.length);
      buffer = [];
      continue;
    }
    if (current === null) continue; // header
    buffer.push(line);
  }
  // The file ends with a trailing newline from `join + "\n"`, which shows up as
  // one extra empty line on the last section; `flush` drops it.
  flush();
  return sections;
}

/** Human-readable report of how `actual` differs from `expected`. */
export function diffSnapshots(expected: Map<string, string>, actual: Map<string, string>): string {
  const report: string[] = [];

  for (const name of expected.keys()) {
    if (!actual.has(name)) report.push(`  - missing output: ${name}`);
  }
  for (const name of actual.keys()) {
    if (!expected.has(name)) report.push(`  + unexpected output: ${name}`);
  }

  for (const [name, want] of expected) {
    const got = actual.get(name);
    if (got === undefined || got === want) continue;
    report.push("", `  ~ ${name}`, ...indent(diffLines(want, got)));
  }

  return report.join("\n");
}

const MAX_DIFF_LINES = 40;

function diffLines(expected: string, actual: string): string[] {
  const a = expected.split("\n");
  const b = actual.split("\n");

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;

  const out: string[] = [];
  if (head > 0) out.push(`  … ${head} identical line(s)`);
  const removed = a.slice(head, a.length - tail);
  const added = b.slice(head, b.length - tail);
  const budget = Math.max(1, Math.floor(MAX_DIFF_LINES / 2));
  for (const line of removed.slice(0, budget)) out.push(`- ${line}`);
  if (removed.length > budget) out.push(`- … ${removed.length - budget} more expected line(s)`);
  for (const line of added.slice(0, budget)) out.push(`+ ${line}`);
  if (added.length > budget) out.push(`+ … ${added.length - budget} more actual line(s)`);
  if (tail > 0) out.push(`  … ${tail} identical line(s)`);
  return out;
}

function indent(lines: string[]): string[] {
  return lines.map((l) => `      ${l}`);
}
