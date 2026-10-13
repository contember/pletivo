/** The oldest TypeScript a consumer may check published source with: pletivo's peer range floor. */
export const MIN_TYPESCRIPT = "5.7.3";

export interface CommandResult {
  ok: boolean;
  output: string;
}

export function run(command: string[], cwd: string, env?: Record<string, string>): CommandResult {
  const result = Bun.spawnSync(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: env === undefined ? undefined : { ...process.env, ...env },
  });
  return {
    ok: result.exitCode === 0,
    output: result.stdout.toString() + result.stderr.toString(),
  };
}

export function requireSuccess(label: string, result: CommandResult): void {
  if (!result.ok) throw new Error(`${label} failed:\n${result.output}`);
}
