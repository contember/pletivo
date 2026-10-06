/** One reason `pletivo prepare` refused a project. */
export interface PrepareDiagnostic {
  source: string;
  hook: string;
  reason: string;
}

export class PrepareError extends Error {
  constructor(readonly diagnostics: readonly PrepareDiagnostic[]) {
    const summary = diagnostics.map((entry) => `${entry.source} (${entry.hook}): ${entry.reason}`).join("; ");
    super(`[pletivo prepare] ${summary}`);
    this.name = "PrepareError";
  }
}

export function prepareFailure(source: string, hook: string, reason: string): PrepareError {
  return new PrepareError([{ source, hook, reason }]);
}
