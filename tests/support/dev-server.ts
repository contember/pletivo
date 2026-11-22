import path from "path";

const cliPath = path.resolve(import.meta.dir, "../../packages/pletivo/src/cli.ts");
const READY_LINE = /dev server running at (http:\/\/\S+)/;

export interface DevServer {
  /** Origin the server bound, without a trailing slash. */
  url: string;
  /** stdout and stderr so far, interleaved by arrival. */
  output(): string;
  stop(): Promise<void>;
}

export interface DevServerOptions {
  cwd: string;
  /** Extra `pletivo dev` arguments; `--port` is always 0. */
  args?: string[];
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

/**
 * Start `pletivo dev --port=0` and resolve with the port the OS gave it.
 * A fixed or random port can be held by another process on a shared machine; port 0 cannot.
 */
export async function startDevServer(options: DevServerOptions): Promise<DevServer> {
  const proc = Bun.spawn([process.execPath, cliPath, "dev", "--port=0", ...(options.args ?? [])], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdout: "pipe",
    stderr: "pipe",
  });

  let output = "";
  let onOutput = () => {};
  // Keep draining both pipes for the server's lifetime; a full pipe blocks its logging.
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      output += decoder.decode(chunk, { stream: true });
      onOutput();
    }
  };
  const drained = Promise.all([drain(proc.stdout), drain(proc.stderr)]);

  const stop = async () => {
    proc.kill();
    await proc.exited;
    await drained;
  };

  const timeoutMs = options.timeoutMs ?? 15_000;
  const url = await new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    onOutput = () => {
      const match = output.match(READY_LINE);
      if (!match) return;
      clearTimeout(timer);
      resolve(match[1].replace(/\/$/, ""));
    };
    proc.exited.then(() => {
      clearTimeout(timer);
      resolve(null);
    });
  });
  onOutput = () => {};

  if (url === null) {
    await stop();
    throw new Error(`pletivo dev did not report a URL within ${timeoutMs}ms:\n${output}`);
  }
  return { url, output: () => output, stop };
}
