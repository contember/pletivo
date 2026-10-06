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
  const modules = sortedEntries(input.modules);
  return `program-v1:${await digest(JSON.stringify({ mainModule: input.mainModule, modules }))}`;
}

/** Name a reusable isolate by program and every immutable factory input. */
export async function isolateKey(input: IsolateKeyInput): Promise<IsolateKey> {
  const { namespace, platform, policy } = input;
  // The tenant is the caller's; everything else here the host builds itself.
  if (namespace.tenant.trim() === "") {
    throw new ExecutionIdentityError("isolate.namespace.tenant", "expected a non-empty string");
  }
  const canonical = {
    programHash: input.programHash,
    namespace: { tenant: namespace.tenant, capabilityGeneration: namespace.capabilityGeneration },
    platform: {
      hostAbi: platform.hostAbi,
      compatibilityDate: platform.compatibilityDate,
      compatibilityFlags: [...platform.compatibilityFlags].sort(compareStrings),
    },
    policy: {
      outbound: policy.outbound,
      env:
        policy.env === null
          ? null
          : { client: sortedEntries(policy.env.client), server: sortedEntries(policy.env.server) },
      importMetaEnv: policy.importMetaEnv === null ? null : sortedEntries(policy.importMetaEnv),
    },
  };
  return `isolate-v1:${await digest(JSON.stringify(canonical))}`;
}

function sortedEntries(record: Readonly<Record<string, string>>): Array<[string, string]> {
  return Object.entries(record).sort((left, right) => compareStrings(left[0], right[0]));
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function digest(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digestBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digestBytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
