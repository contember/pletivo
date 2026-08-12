import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

interface ChildLogs {
  stdout: string[];
  stderr: string[];
}

async function allocatePort(): Promise<number> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = server.port;
  await server.stop(true);
  return port;
}

async function collect(
  stream: ReadableStream<Uint8Array>,
  lines: string[],
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    pending += decoder.decode(next.value, { stream: true });
    const chunks = pending.split("\n");
    pending = chunks.pop() ?? "";
    lines.push(...chunks);
  }
  pending += decoder.decode();
  if (pending !== "") lines.push(pending);
}

async function waitReady(url: string, process: Bun.Subprocess, logs: ChildLogs): Promise<void> {
  const deadline = Date.now() + 20_000;
  let lastError = "not attempted";
  while (Date.now() < deadline) {
    if (process.exitCode !== null) {
      throw new Error(`process exited before readiness with ${process.exitCode}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(100);
  }
  throw new Error(
    `readiness timeout for ${url}: ${lastError}\nstdout:\n${logs.stdout.join("\n")}\n` +
      `stderr:\n${logs.stderr.join("\n")}`,
  );
}

async function bounded<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<T>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms`)), milliseconds);
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function stopChild(
  child: Bun.Subprocess,
  label: string,
  cleanupErrors: string[],
): Promise<void> {
  if (child.exitCode !== null) return;
  try {
    child.kill();
    await bounded(child.exited, 5_000, `${label} graceful cleanup`);
    return;
  } catch {
    // A stuck dev server must not keep CI alive after the qualification has ended.
  }
  try {
    child.kill(9);
    await bounded(child.exited, 5_000, `${label} forced cleanup`);
  } catch (error) {
    cleanupErrors.push(
      `${label}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function requireObject(value: unknown, path: string): object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value;
}

function field(object: object, name: string, path: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(object, name)) {
    throw new Error(`${path}.${name} is missing`);
  }
  return Reflect.get(object, name);
}

function requireTrue(object: object, name: string, path: string): void {
  if (field(object, name, path) !== true) throw new Error(`${path}.${name} must be true`);
}

function validateReport(value: unknown): void {
  const report = requireObject(value, "$report");
  const identity = requireObject(field(report, "identity", "$report"), "$report.identity");
  for (const name of [
    "sameProgramHash",
    "sameLoaderId",
    "loaderCalledTwice",
    "factoryOnce",
    "moduleCounterAdvanced",
    "tenantPartitioned",
    "tenantCounterReset",
    "sourcePartitioned",
    "sourceCounterReset",
    "capabilityPartitioned",
  ]) requireTrue(identity, name, "$report.identity");

  const content = requireObject(field(report, "content", "$report"), "$report.content");
  for (const name of [
    "missingNamespaceNamed",
    "missingNamespaceZeroGets",
    "editedBytesSameProgramHash",
    "editedBytesSameLoaderId",
    "editedBytesTwoCallsOneModule",
    "editedBytesChangedOutput",
    "overlapObserved",
    "overlapIsolated",
    "throwIsolated",
    "recovered",
    "handlesClosed",
  ]) requireTrue(content, name, "$report.content");

  const runtime = requireObject(field(report, "runtime", "$report"), "$report.runtime");
  requireTrue(runtime, "contentStarted", "$report.runtime");
  requireTrue(runtime, "dynamicCodeRefused", "$report.runtime");
  requireTrue(runtime, "withoutNodeCompatFailedStart", "$report.runtime");

  const outbound = requireObject(field(report, "outbound", "$report"), "$report.outbound");
  for (const name of [
    "blocked",
    "proxy",
    "inherit",
    "blockedOneLoaderCall",
    "proxyOneLoaderCall",
    "inheritOneLoaderCall",
    "blockedZeroSidecarHits",
    "proxyOneSidecarHit",
    "inheritOneSidecarHit",
    "proxyMarked",
    "inheritUnmarked",
  ]) {
    requireTrue(outbound, name, "$report.outbound");
  }
}

const nonce = crypto.randomUUID();
const sidecarPort = await allocatePort();
const wranglerPort = await allocatePort();
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pletivo-workerd-"));
const persistence = path.join(tempRoot, "persistence");
const wranglerHome = path.join(tempRoot, "wrangler-home");
const wranglerConfig = path.join(tempRoot, "wrangler.jsonc");
await fs.mkdir(persistence);
await fs.mkdir(wranglerHome);
const sourceConfig = await fs.readFile(path.join(import.meta.dir, "wrangler.jsonc"), "utf8");
const stagedConfig = sourceConfig.replace(
  '"main": "entry.ts"',
  `"main": ${JSON.stringify(path.join(import.meta.dir, "entry.ts"))}`,
);
if (stagedConfig === sourceConfig) throw new Error("workerd config main entry was not staged");
await fs.writeFile(wranglerConfig, stagedConfig);
const sidecarLogs: ChildLogs = { stdout: [], stderr: [] };
const wranglerLogs: ChildLogs = { stdout: [], stderr: [] };
const sidecar = Bun.spawn(
  [process.execPath, path.join(import.meta.dir, "sidecar.ts"), String(sidecarPort), nonce],
  { stdout: "pipe", stderr: "pipe" },
);
const wrangler = Bun.spawn(
  [
    "node",
    path.resolve(import.meta.dir, "../../node_modules/wrangler/bin/wrangler.js"),
    "dev",
    "--local",
    "--config",
    wranglerConfig,
    "--ip",
    "127.0.0.1",
    "--port",
    String(wranglerPort),
    "--persist-to",
    persistence,
  ],
  {
    cwd: tempRoot,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: wranglerHome,
      WRANGLER_HOME: wranglerHome,
      WRANGLER_SEND_METRICS: "false",
    },
    stdout: "pipe",
    stderr: "pipe",
  },
);
const collectors = [
  collect(sidecar.stdout, sidecarLogs.stdout),
  collect(sidecar.stderr, sidecarLogs.stderr),
  collect(wrangler.stdout, wranglerLogs.stdout),
  collect(wrangler.stderr, wranglerLogs.stderr),
];

let primaryError: unknown;
const cleanupErrors: string[] = [];
try {
  await waitReady(`http://127.0.0.1:${sidecarPort}/ready`, sidecar, sidecarLogs);
  await waitReady(`http://127.0.0.1:${wranglerPort}/ready`, wrangler, wranglerLogs);
  const response = await bounded(
    fetch(`http://127.0.0.1:${wranglerPort}/qualify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        nonce,
        sidecar: `http://127.0.0.1:${sidecarPort}/probe?nonce=${encodeURIComponent(nonce)}`,
      }),
      signal: AbortSignal.timeout(120_000),
    }),
    125_000,
    "qualification request",
  );
  const responseText = await bounded(response.text(), 5_000, "qualification response body");
  if (!response.ok) {
    throw new Error(`qualification returned HTTP ${response.status}: ${responseText}`);
  }
  let report: unknown;
  try {
    report = JSON.parse(responseText);
  } catch (error) {
    throw new Error(`qualification returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  validateReport(report);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  primaryError = error;
} finally {
  await Promise.all([
    stopChild(sidecar, "sidecar", cleanupErrors),
    stopChild(wrangler, "wrangler", cleanupErrors),
  ]);
  try {
    await bounded(Promise.allSettled(collectors), 5_000, "log collector cleanup");
  } catch (error) {
    cleanupErrors.push(error instanceof Error ? error.message : String(error));
  }
  try {
    await bounded(fs.rm(tempRoot, { recursive: true, force: true }), 10_000, "temporary root cleanup");
  } catch (error) {
    cleanupErrors.push(error instanceof Error ? error.message : String(error));
  }
}

if (primaryError !== undefined || cleanupErrors.length > 0) {
  const primary = primaryError === undefined
    ? "qualification succeeded"
    : primaryError instanceof Error
      ? (primaryError.stack ?? primaryError.message)
      : String(primaryError);
  const cleanup = cleanupErrors.length === 0
    ? ""
    : `\ncleanup errors:\n${cleanupErrors.join("\n")}`;
  throw new Error(
    `${primary}\n` +
      `sidecar stdout:\n${sidecarLogs.stdout.join("\n")}\n` +
      `sidecar stderr:\n${sidecarLogs.stderr.join("\n")}\n` +
      `wrangler stdout:\n${wranglerLogs.stdout.join("\n")}\n` +
      `wrangler stderr:\n${wranglerLogs.stderr.join("\n")}` +
      cleanup,
  );
}
