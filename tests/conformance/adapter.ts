/**
 * The adapter seam.
 *
 * The conformance harness knows nothing about how a corpus entry gets rendered.
 * It hands the corpus to a `ConformanceAdapter`, gets back "output path → text"
 * per case, normalizes it, and diffs it against the committed snapshot. The
 * snapshots are therefore adapter-independent: a second runtime (the planned
 * Cloudflare Workers one) is conformant exactly when it reproduces the same
 * files through the same interface.
 *
 * Keying by *output path* rather than by route URL is deliberate — it is the
 * one vocabulary both shapes of runtime can speak. A build-style adapter walks
 * its output directory; a request-style adapter maps each route URL onto the
 * path a static build would have written (`/about` → `about/index.html`).
 */
import type { CorpusEntry } from "./corpus";

/** Extensions read back as text. Everything else is listed but not compared. */
export const TEXT_EXTENSIONS = [".html", ".xml", ".txt", ".json"];

export interface CaseRender {
  /**
   * Rendered text keyed by output path, relative to the case's output root and
   * always posix-separated (`blog/post-one/index.html`).
   */
  outputs: Map<string, string>;
  /**
   * Every file the render produced, including binary assets and JS/CSS bundles
   * whose bytes are not compared. Optional: an adapter that answers requests on
   * demand has no output directory to enumerate, in which case the case's
   * snapshot simply carries no `emitted` section.
   */
  emitted?: string[];
  /** Populated instead of `outputs` when the case failed to render. */
  error?: string;
}

export interface ConformanceAdapter {
  /** Stable name, used in test titles and in `CONFORMANCE_ADAPTER`. */
  readonly name: string;
  /**
   * Render every entry. Batched rather than one-at-a-time so an adapter that
   * pays a large fixed startup cost (spawning a runtime, booting a worker) pays
   * it once. Implementations must not throw for a single failing entry — set
   * `error` on that entry's result instead.
   *
   * `workRoot` is a scratch directory owned by the caller; the adapter may
   * write anything under it and must not write outside it.
   */
  render(entries: CorpusEntry[], workRoot: string): Promise<Map<string, CaseRender>>;
}

export function isTextOutput(file: string): boolean {
  return TEXT_EXTENSIONS.some((ext) => file.endsWith(ext));
}
