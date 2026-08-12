/**
 * Rendering conformance harness.
 *
 * Renders a corpus of real projects from this repo, normalizes the output, and
 * diffs it against snapshots committed under `tests/conformance/snapshots/`.
 * Its job is to make rendering changes *visible*: a refactor that splits the
 * package, or a second runtime that renders the same pages differently, shows
 * up here as a diff instead of as a silent behaviour change in production.
 *
 * Run:
 *   bun test tests/conformance                       # fast tier (default)
 *   CONFORMANCE_FULL=1 bun test tests/conformance    # + the benchmark examples
 *   CONFORMANCE_CASE=i18n,base-path bun test tests/conformance
 *   CONFORMANCE_ADAPTER=<name> bun test tests/conformance
 *   CONFORMANCE_ISOLATE=1 bun test tests/conformance # one child process per case
 *
 * Regenerate snapshots after an intended rendering change — review the diff
 * before committing, that review is the entire point of the harness:
 *   UPDATE_SNAPSHOTS=1 bun test tests/conformance
 *
 * What is compared: the text of every emitted `.html` / `.xml` / `.txt` /
 * `.json` output, plus the sorted list of every file the build emitted. JS and
 * CSS bundle *contents* are deliberately not compared — they are minified by
 * whichever bundler the runtime uses, so their bytes track the toolchain rather
 * than the rendering. The manifest still catches a bundle that stops being
 * emitted, and the HTML still catches a page that stops referencing it.
 */
import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test";
import path from "path";
import os from "os";
import fs from "fs/promises";
import { repoRoot, selectCorpus, type CorpusEntry } from "./corpus";
import { resolveAdapter } from "./adapters";
import { createNormalizer } from "./normalize";
import { EMITTED_SECTION, diffSnapshots, formatSnapshot, parseSnapshot } from "./snapshot";
import type { CaseRender } from "./adapter";

// The whole corpus is rendered in `beforeAll`; give the spawned build room.
setDefaultTimeout(180_000);

const adapter = resolveAdapter();
const entries = selectCorpus();
const updating = process.env.UPDATE_SNAPSHOTS === "1";
const snapshotDir = path.join(import.meta.dir, "snapshots");

let workRoot = "";
let rendered = new Map<string, CaseRender>();

describe(`conformance (${adapter.name})`, () => {
  beforeAll(async () => {
    workRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pletivo-conformance-"));
    rendered = await adapter.render(entries, workRoot);
    if (updating) await fs.mkdir(snapshotDir, { recursive: true });
  });

  afterAll(async () => {
    if (workRoot) await fs.rm(workRoot, { recursive: true, force: true });
  });

  for (const entry of entries) {
    test(entry.id, async () => {
      const result = rendered.get(entry.id);
      if (!result) throw new Error(`adapter "${adapter.name}" returned no result for "${entry.id}"`);
      if (result.error) throw new Error(`rendering "${entry.id}" failed:\n${result.error}`);

      const sections = buildSections(entry, result);
      const snapshotPath = path.join(snapshotDir, `${entry.id}.snap`);
      const actualText = formatSnapshot(entry, sections, adapter.name);

      if (updating) {
        await fs.writeFile(snapshotPath, actualText);
        return;
      }

      const expectedText = await readIfPresent(snapshotPath);
      if (expectedText === undefined) {
        throw new Error(
          `no snapshot for "${entry.id}" at ${path.relative(repoRoot, snapshotPath)}\n` +
            `Record it with: UPDATE_SNAPSHOTS=1 CONFORMANCE_CASE=${entry.id} bun test tests/conformance`,
        );
      }
      if (actualText === expectedText) return;

      const report = diffSnapshots(parseSnapshot(expectedText), parseSnapshot(actualText));
      throw new Error(
        `rendering conformance drift in "${entry.id}" (adapter: ${adapter.name})\n` +
          `snapshot: ${path.relative(repoRoot, snapshotPath)}\n` +
          `  "-" is the committed snapshot, "+" is what ${adapter.name} rendered now.\n` +
          (report || "  (header changed — the case's `covers` list or project path was edited)") +
          `\n\nIf the change is intended, review it and re-record:\n` +
          `  UPDATE_SNAPSHOTS=1 CONFORMANCE_CASE=${entry.id} bun test tests/conformance`,
      );
    });
  }

  // A renamed or deleted corpus entry leaves its snapshot behind, where it
  // silently stops protecting anything. Only meaningful when the full corpus
  // ran, since the fast tier legitimately leaves the `full` snapshots untouched.
  test.skipIf(process.env.CONFORMANCE_FULL !== "1" || !!process.env.CONFORMANCE_CASE)(
    "no orphaned snapshots",
    async () => {
      const files = await fs.readdir(snapshotDir).catch(() => [] as string[]);
      const known = new Set(entries.map((e) => `${e.id}.snap`));
      const orphans = files.filter((f) => f.endsWith(".snap") && !known.has(f));
      expect(orphans).toEqual([]);
    },
  );
});

function buildSections(entry: CorpusEntry, result: CaseRender): Map<string, string> {
  const normalize = createNormalizer({ repoRoot, workRoot, options: entry.normalize });
  const sections = new Map<string, string>();

  // The manifest is normalized first so asset-hash ordinals are numbered by the
  // build's own output order, not by whichever page happened to reference them.
  if (!entry.routes && result.emitted) {
    sections.set(EMITTED_SECTION, normalize(EMITTED_SECTION, result.emitted.join("\n")));
  }

  const excluded = new Set(entry.excludeRoutes ?? []);
  // A stale exclusion is worse than none: it would quietly stop covering a
  // route that has since been renamed or dropped.
  for (const file of excluded) {
    if (!result.outputs.has(file)) {
      throw new Error(`case "${entry.id}" excludes route "${file}", which the render did not emit`);
    }
  }
  const paths = (entry.routes ?? [...result.outputs.keys()].sort()).filter((f) => !excluded.has(f));
  for (const file of paths) {
    const raw = result.outputs.get(file);
    if (raw === undefined) {
      throw new Error(
        `case "${entry.id}" lists route "${file}" but the render did not emit it.\n` +
          `emitted: ${(result.emitted ?? [...result.outputs.keys()]).join(", ")}`,
      );
    }
    sections.set(file, normalize(file, raw));
  }
  return sections;
}

async function readIfPresent(file: string): Promise<string | undefined> {
  try {
    return await Bun.file(file).text();
  } catch {
    return undefined;
  }
}
