export type ProgramHash = string;
export type IsolateKey = string;

export interface ExecutionNamespace {
  tenant: string;
  /** Host-controlled identity for every opaque capability bound to the isolate. */
  capabilityGeneration: string;
}

export interface ExecutionPlatform {
  hostAbi: string;
  compatibilityDate: string;
  compatibilityFlags: readonly string[];
}

export interface ProgramHashInput {
  mainModule: string;
  modules: Readonly<Record<string, string>>;
}

export interface ImmutableEnvPayload {
  client: Readonly<Record<string, string>>;
  server: Readonly<Record<string, string>>;
}

export type FactoryOutboundKind = "blocked" | "proxy" | "inherit";

/** Values fixed by the Loader factory on the isolate's first creation. */
export interface ImmutableFactoryPolicy {
  outbound: FactoryOutboundKind;
  env: ImmutableEnvPayload | null;
  importMetaEnv: Readonly<Record<string, string>> | null;
}

export interface IsolateKeyInput {
  programHash: ProgramHash;
  namespace: ExecutionNamespace;
  platform: ExecutionPlatform;
  policy: ImmutableFactoryPolicy;
}

export class ExecutionIdentityError extends Error {
  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(`[pletivo-workers] invalid execution identity at ${path}: ${reason}`);
    this.name = "ExecutionIdentityError";
  }
}

/** Hash the exact Loader program with unambiguous JSON framing. */
export async function programHash(input: ProgramHashInput): Promise<ProgramHash> {
  requireNonEmpty(input.mainModule, "program.mainModule");
  const modules = sortedRecordEntries(input.modules, "program.modules");
  return `program-v1:${await digest(JSON.stringify({ mainModule: input.mainModule, modules }))}`;
}

/** Name a reusable isolate by program and every immutable factory input. */
export async function isolateKey(input: IsolateKeyInput): Promise<IsolateKey> {
  requireNonEmpty(input.programHash, "isolate.programHash");
  requireNonEmpty(input.namespace.tenant, "isolate.namespace.tenant");
  requireNonEmpty(
    input.namespace.capabilityGeneration,
    "isolate.namespace.capabilityGeneration",
  );
  requireNonEmpty(input.platform.hostAbi, "isolate.platform.hostAbi");
  requireNonEmpty(input.platform.compatibilityDate, "isolate.platform.compatibilityDate");

  const compatibilityFlags = canonicalFlags(input.platform.compatibilityFlags);
  const env =
    input.policy.env === null
      ? null
      : {
          client: sortedRecordEntries(input.policy.env.client, "isolate.policy.env.client"),
          server: sortedRecordEntries(input.policy.env.server, "isolate.policy.env.server"),
        };
  const importMetaEnv =
    input.policy.importMetaEnv === null
      ? null
      : sortedRecordEntries(
          input.policy.importMetaEnv,
          "isolate.policy.importMetaEnv",
        );
  const outbound = validateOutbound(input.policy.outbound);
  const canonical = {
    programHash: input.programHash,
    namespace: {
      tenant: input.namespace.tenant,
      capabilityGeneration: input.namespace.capabilityGeneration,
    },
    platform: {
      hostAbi: input.platform.hostAbi,
      compatibilityDate: input.platform.compatibilityDate,
      compatibilityFlags,
    },
    policy: {
      outbound,
      env,
      importMetaEnv,
    },
  };
  return `isolate-v1:${await digest(JSON.stringify(canonical))}`;
}

function validateOutbound(value: unknown): FactoryOutboundKind {
  if (value === "blocked" || value === "proxy" || value === "inherit") return value;
  throw new ExecutionIdentityError(
    "isolate.policy.outbound",
    'expected "blocked", "proxy", or "inherit"',
  );
}

function canonicalFlags(flags: readonly string[]): string[] {
  const seen = new Set<string>();
  const canonical: string[] = [];
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index];
    requireNonEmpty(flag, `isolate.platform.compatibilityFlags[${index}]`);
    if (seen.has(flag)) {
      throw new ExecutionIdentityError(
        `isolate.platform.compatibilityFlags[${index}]`,
        `duplicate flag ${JSON.stringify(flag)}`,
      );
    }
    seen.add(flag);
    canonical.push(flag);
  }
  return canonical.sort(compareStrings);
}

function sortedRecordEntries(
  record: Readonly<Record<string, string>>,
  path: string,
): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const [name, body] of Object.entries(record)) {
    requireNonEmpty(name, `${path}.name`);
    if (typeof body !== "string") {
      throw new ExecutionIdentityError(`${path}.${name}`, "expected a string");
    }
    entries.push([name, body]);
  }
  return entries.sort((left, right) => compareStrings(left[0], right[0]));
}

function requireNonEmpty(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ExecutionIdentityError(path, "expected a non-empty string");
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function digest(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digestBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digestBytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
