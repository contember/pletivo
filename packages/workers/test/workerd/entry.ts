import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import {
  ContentFiles,
  type ContentBinding,
  type ContentFileRef,
  type ImageInfo,
} from "../../src/content-files.ts";
import type { ExecutionNamespace } from "../../src/execution-identity.ts";
import type { OutboundAccess, OutboundBinding } from "../../src/outbound.ts";
import {
  ExecutionIdentityError,
} from "../../src/execution-identity.ts";
import {
  renderPage,
  type DynamicWorkerCode,
  type RenderedPage,
  type WorkerLoaderBinding,
} from "../../src/render.ts";

interface Env {
  QUALIFIER: DurableObjectNamespace<QualificationDO>;
  LOADER: WorkerLoaderBinding;
}

type QualificationBinding = ContentBinding & OutboundBinding;

interface Barrier {
  arrived: number;
  overlapped: boolean;
  promise: Promise<void>;
  release(): void;
}

interface IdentityReport {
  sameProgramHash: boolean;
  sameLoaderId: boolean;
  loaderCalledTwice: boolean;
  factoryOnce: boolean;
  moduleCounterAdvanced: boolean;
  tenantPartitioned: boolean;
  tenantCounterReset: boolean;
  sourcePartitioned: boolean;
  sourceCounterReset: boolean;
  capabilityPartitioned: boolean;
}

interface ContentReport {
  missingNamespaceNamed: boolean;
  missingNamespaceZeroGets: boolean;
  editedBytesSameProgramHash: boolean;
  editedBytesSameLoaderId: boolean;
  editedBytesTwoCallsOneModule: boolean;
  editedBytesChangedOutput: boolean;
  overlapObserved: boolean;
  overlapIsolated: boolean;
  throwIsolated: boolean;
  recovered: boolean;
  handlesClosed: boolean;
}

interface RuntimeReport {
  contentStarted: boolean;
  dynamicCodeRefused: boolean;
  withoutNodeCompatFailedStart: boolean;
}

interface OutboundReport {
  blocked: boolean;
  proxy: boolean;
  inherit: boolean;
  blockedOneLoaderCall: boolean;
  proxyOneLoaderCall: boolean;
  inheritOneLoaderCall: boolean;
  blockedZeroSidecarHits: boolean;
  proxyOneSidecarHit: boolean;
  inheritOneSidecarHit: boolean;
  proxyMarked: boolean;
  inheritUnmarked: boolean;
}

interface QualificationReport {
  identity: IdentityReport;
  content: ContentReport;
  runtime: RuntimeReport;
  outbound: OutboundReport;
}

class ExecutionRecords {
  readonly ids: string[] = [];
  readonly programHashes: string[] = [];

  onLoaderGet(key: string, programHash: string): void {
    this.ids.push(key);
    this.programHashes.push(programHash);
  }

  get lastId(): string {
    const id = this.ids[this.ids.length - 1];
    if (id === undefined) throw new Error("Loader was not called");
    return id;
  }
}

const COUNTER_PAGE = `---
import { next } from "../lib/counter.js";
const count = next();
---
<p id="counter">{count}</p>
`;

const COUNTER_MODULE = `let count = 0;
export function next() { return ++count; }
`;

const CONTENT_CONFIG = `import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";
export const collections = {
  notes: defineCollection({
    loader: glob({ base: "src/content/notes" }),
    schema: z.object({ title: z.string() }),
  }),
};
`;

const CONTENT_PAGE = `---
import { getCollection } from "astro:content";
import { next } from "../lib/counter.js";
const notes = await getCollection("notes");
const count = next();
---
<p id="titles">{notes.map((note) => note.data.title).join(",")}</p>
<p id="content-counter">{count}</p>
`;

const LOADER_PROBE_CODE = {
  compatibilityDate: "2026-01-01",
  compatibilityFlags: ["nodejs_compat"],
  mainModule: "entry.js",
  modules: {
    "entry.js": `export default { fetch() { return new Response("loader-probe"); } };`,
  },
  globalOutbound: null,
};

let loaderProbeFactoryCalls = 0;

function loaderProbeFactory(): DynamicWorkerCode {
  loaderProbeFactoryCalls++;
  return LOADER_PROBE_CODE;
}

function counterProject(counterSource = COUNTER_MODULE): Map<string, string> {
  return new Map([
    ["src/pages/index.astro", COUNTER_PAGE],
    ["src/lib/counter.js", counterSource],
  ]);
}

function contentProject(title: string, marker = ""): Map<string, string> {
  return new Map([
    ["src/content.config.ts", CONTENT_CONFIG],
    ["src/pages/index.astro", CONTENT_PAGE],
    ["src/lib/counter.js", COUNTER_MODULE],
    ["src/content/notes/note.md", `---\ntitle: ${title}\n---\n${marker}\n`],
  ]);
}

function namespace(tenant: string, capabilityGeneration: string): ExecutionNamespace {
  return { tenant, capabilityGeneration };
}

function htmlValue(html: string, id: string): string {
  const match = new RegExp(`<p id="${id}">([^<]*)</p>`).exec(html);
  if (!match) throw new Error(`rendered HTML has no ${id} value: ${html}`);
  return match[1];
}

function createBarrier(): Barrier {
  let settle: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return {
    arrived: 0,
    overlapped: false,
    promise,
    release() {
      if (!settle) throw new Error("barrier was not initialized");
      settle();
    },
  };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "non-error";
}

export class QualificationDO extends DurableObject<Env> {
  readonly #content = new ContentFiles();
  readonly #execution = new ExecutionRecords();
  #barrier: Barrier | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async scan(ref: string, dir: string, pattern: string): Promise<ContentFileRef[]> {
    const found = this.#content.scan(ref, dir, pattern);
    const barrier = this.#barrier;
    if (barrier) {
      barrier.arrived++;
      if (barrier.arrived === 2) {
        barrier.overlapped = true;
        barrier.release();
      }
      await barrier.promise;
    }
    return found;
  }

  read(ref: string, path: string): string | null {
    const source = this.#content.read(ref, path);
    if (source?.includes("FORCE_READ_THROW")) throw new Error("forced workerd content failure");
    return source;
  }

  async image(ref: string, path: string): Promise<ImageInfo | null> {
    return await this.#content.image(ref, path);
  }

  fetch(request: Request): Promise<Response> {
    return fetch(request);
  }

  async qualify(sidecar: string, nonce: string): Promise<QualificationReport> {
    const probeId = `pletivo-workerd-loader-probe-v1:${nonce}`;
    const factoryCallsBefore = loaderProbeFactoryCalls;
    const firstProbe = this.env.LOADER.get(probeId, loaderProbeFactory);
    const secondProbe = this.env.LOADER.get(probeId, loaderProbeFactory);
    const probeResponses = await Promise.all([
      firstProbe.getEntrypoint().fetch(new Request("http://probe.invalid/first")),
      secondProbe.getEntrypoint().fetch(new Request("http://probe.invalid/second")),
    ]);
    if ((await probeResponses[0].text()) !== "loader-probe" ||
      (await probeResponses[1].text()) !== "loader-probe") {
      throw new Error("direct Worker Loader probe returned an unexpected response");
    }
    const factoryOnce = loaderProbeFactoryCalls - factoryCallsBefore === 1;
    const binding = this.ctx.exports.PletivoBinding({ props: { nonce } });
    const identity = await this.#identity(nonce, binding, factoryOnce);
    const content = await this.#contentQualification(nonce, binding);
    const runtime = await this.#runtime(nonce, binding);
    const outbound = await this.#outbound(nonce, sidecar, binding);
    return { identity, content, runtime, outbound };
  }

  async #render(
    files: ReadonlyMap<string, string>,
    executionNamespace: ExecutionNamespace,
    input: {
      content?: QualificationBinding;
      outbound?: OutboundAccess;
      compatibilityFlags?: readonly string[];
    } = {},
  ): Promise<RenderedPage> {
    return renderPage({
      files,
      pathname: "/",
      loader: this.env.LOADER,
      executionObserver: this.#execution,
      executionNamespace,
      ...(input.content
        ? { content: { binding: input.content, store: this.#content } }
        : {}),
      outbound: input.outbound,
      compatibilityFlags: input.compatibilityFlags,
    });
  }

  async #identity(
    nonce: string,
    binding: QualificationBinding,
    factoryOnce: boolean,
  ): Promise<IdentityReport> {
    const project = counterProject();
    const tenantA = namespace(`${nonce}:identity-a`, "cap-v1");
    const first = await this.#render(project, tenantA);
    const firstId = this.#execution.lastId;
    const second = await this.#render(project, tenantA);
    const secondId = this.#execution.lastId;
    const tenant = await this.#render(project, namespace(`${nonce}:identity-b`, "cap-v1"));
    const tenantId = this.#execution.lastId;
    const changed = await this.#render(
      counterProject(`${COUNTER_MODULE} `),
      tenantA,
    );
    const changedId = this.#execution.lastId;

    const contentFiles = contentProject("Capability");
    await this.#render(contentFiles, namespace(`${nonce}:content-cap`, "cap-v1"), { content: binding });
    const capabilityA = this.#execution.lastId;
    await this.#render(contentFiles, namespace(`${nonce}:content-cap`, "cap-v2"), { content: binding });
    const capabilityB = this.#execution.lastId;

    return {
      sameProgramHash: first.bundleId === second.bundleId,
      sameLoaderId: firstId === secondId,
      loaderCalledTwice: this.#execution.ids.filter((id) => id === firstId).length === 2,
      factoryOnce,
      moduleCounterAdvanced:
        htmlValue(first.html, "counter") === "1" && htmlValue(second.html, "counter") === "2",
      tenantPartitioned: tenantId !== firstId,
      tenantCounterReset: htmlValue(tenant.html, "counter") === "1",
      sourcePartitioned: changed.bundleId !== first.bundleId && changedId !== firstId,
      sourceCounterReset: htmlValue(changed.html, "counter") === "1",
      capabilityPartitioned: capabilityA !== capabilityB,
    };
  }

  async #contentQualification(
    nonce: string,
    binding: QualificationBinding,
  ): Promise<ContentReport> {
    const withoutNamespaceGets = this.#execution.ids.length;
    let missingNamespaceNamed = false;
    try {
      await renderPage({
        files: contentProject("No namespace"),
        pathname: "/",
        loader: this.env.LOADER,
        executionObserver: this.#execution,
        content: { binding, store: this.#content },
      });
    } catch (error) {
      missingNamespaceNamed =
        error instanceof ExecutionIdentityError && errorName(error) === "ExecutionIdentityError";
    }
    const missingNamespaceZeroGets = this.#execution.ids.length === withoutNamespaceGets;

    const editNamespace = namespace(`${nonce}:content-edit`, "cap-v1");
    const editCallsBefore = this.#execution.ids.length;
    const beforeEdit = await this.#render(contentProject("Before"), editNamespace, {
      content: binding,
    });
    const editId = this.#execution.lastId;
    const afterEdit = await this.#render(contentProject("After"), editNamespace, {
      content: binding,
    });
    const editCalls = this.#execution.ids.slice(editCallsBefore);

    const overlapNamespace = namespace(`${nonce}:overlap`, "cap-v1");
    this.#barrier = createBarrier();
    const overlap = await Promise.all([
      this.#render(contentProject("Left"), overlapNamespace, { content: binding }),
      this.#render(contentProject("Right"), overlapNamespace, { content: binding }),
    ]);
    const overlapObserved = this.#barrier.overlapped;
    const overlapIsolated =
      htmlValue(overlap[0].html, "titles") === "Left" &&
      htmlValue(overlap[1].html, "titles") === "Right";
    this.#barrier = undefined;

    this.#barrier = createBarrier();
    const throwing = await Promise.allSettled([
      this.#render(contentProject("Good"), overlapNamespace, { content: binding }),
      this.#render(
        contentProject("Bad", "FORCE_READ_THROW"),
        overlapNamespace,
        { content: binding },
      ),
    ]);
    const throwOverlap = this.#barrier.overlapped;
    this.#barrier = undefined;
    const good = throwing[0];
    const bad = throwing[1];
    const throwIsolated =
      throwOverlap &&
      good.status === "fulfilled" &&
      htmlValue(good.value.html, "titles") === "Good" &&
      bad.status === "rejected";
    const recovered = await this.#render(
      contentProject("Recovered"),
      overlapNamespace,
      { content: binding },
    );

    return {
      missingNamespaceNamed,
      missingNamespaceZeroGets,
      editedBytesSameProgramHash: beforeEdit.bundleId === afterEdit.bundleId,
      editedBytesSameLoaderId:
        editCalls.length === 2 && editCalls[0] === editId && editCalls[1] === editId,
      editedBytesTwoCallsOneModule:
        editCalls.length === 2 &&
        htmlValue(beforeEdit.html, "content-counter") === "1" &&
        htmlValue(afterEdit.html, "content-counter") === "2",
      editedBytesChangedOutput:
        htmlValue(beforeEdit.html, "titles") === "Before" &&
        htmlValue(afterEdit.html, "titles") === "After",
      overlapObserved,
      overlapIsolated,
      throwIsolated,
      recovered: htmlValue(recovered.html, "titles") === "Recovered",
      handlesClosed: this.#content.openCount === 0,
    };
  }

  async #runtime(
    nonce: string,
    binding: QualificationBinding,
  ): Promise<RuntimeReport> {
    const content = await this.#render(
      contentProject("Runtime"),
      namespace(`${nonce}:runtime`, "cap-v1"),
      { content: binding },
    );
    const dynamicCode = await this.#render(
      new Map([
        [
          "src/pages/index.astro",
          `---
let marker = "allowed";
try { new Function("return 1")(); } catch { marker = "refused"; }
---
<p id="dynamic-code">{marker}</p>
`,
        ],
      ]),
      namespace(`${nonce}:dynamic-code`, "cap-v1"),
    );
    let withoutNodeCompatFailedStart = false;
    try {
      await this.#render(
        contentProject("No compat"),
        namespace(`${nonce}:runtime`, "without-node-compat"),
        { content: binding, compatibilityFlags: [] },
      );
    } catch (error) {
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      withoutNodeCompatFailedStart =
        detail.includes("IsolateStartError") &&
        (detail.includes("node:async_hooks") || detail.includes("nodejs_compat"));
    }
    return {
      contentStarted: htmlValue(content.html, "titles") === "Runtime",
      dynamicCodeRefused: htmlValue(dynamicCode.html, "dynamic-code") === "refused",
      withoutNodeCompatFailedStart,
    };
  }

  async #outbound(
    nonce: string,
    sidecar: string,
    binding: QualificationBinding,
  ): Promise<OutboundReport> {
    const hitsUrl = sidecar.replace("/probe?", "/hits?");
    const readHits = async (): Promise<{ total: number; proxy: number; direct: number }> => {
      const response = await fetch(hitsUrl);
      const value: unknown = await response.json();
      if (typeof value !== "object" || value === null) throw new Error("invalid hit response");
      const hits = Reflect.get(value, "hits");
      const proxy = Reflect.get(value, "proxy");
      const direct = Reflect.get(value, "direct");
      if (typeof hits !== "number" || typeof proxy !== "number" || typeof direct !== "number") {
        throw new Error("invalid hit count");
      }
      return { total: hits, proxy, direct };
    };
    const files = new Map([
      [
        "src/pages/index.astro",
        `---
const response = await fetch(${JSON.stringify(sidecar)});
const value = await response.text();
---
<p id="outbound">{value}</p>
`,
      ],
    ]);
    const initialHits = await readHits();
    const blockedCallsBefore = this.#execution.ids.length;
    let blocked = false;
    try {
      await this.#render(
        files,
        namespace(`${nonce}:outbound`, "blocked"),
        { outbound: { kind: "blocked" } },
      );
    } catch {
      blocked = true;
    }
    const blockedCalls = this.#execution.ids.length - blockedCallsBefore;
    const afterBlockedHits = await readHits();

    const proxyCallsBefore = this.#execution.ids.length;
    const proxyPage = await this.#render(
      files,
      namespace(`${nonce}:outbound`, "proxy"),
      { outbound: { kind: "proxy", binding } },
    );
    const proxyCalls = this.#execution.ids.length - proxyCallsBefore;
    const afterProxyHits = await readHits();

    const inheritCallsBefore = this.#execution.ids.length;
    const inheritPage = await this.#render(
      files,
      namespace(`${nonce}:outbound`, "inherit"),
      { outbound: { kind: "inherit" } },
    );
    const inheritCalls = this.#execution.ids.length - inheritCallsBefore;
    const afterInheritHits = await readHits();
    const proxyValue = htmlValue(proxyPage.html, "outbound");
    const inheritValue = htmlValue(inheritPage.html, "outbound");

    return {
      blocked,
      proxy: proxyValue === `sidecar:${nonce}:proxy`,
      inherit: inheritValue === `sidecar:${nonce}:direct`,
      blockedOneLoaderCall: blockedCalls === 1,
      proxyOneLoaderCall: proxyCalls === 1,
      inheritOneLoaderCall: inheritCalls === 1,
      blockedZeroSidecarHits: afterBlockedHits.total === initialHits.total,
      proxyOneSidecarHit:
        afterProxyHits.total === afterBlockedHits.total + 1 &&
        afterProxyHits.proxy === afterBlockedHits.proxy + 1,
      inheritOneSidecarHit:
        afterInheritHits.total === afterProxyHits.total + 1 &&
        afterInheritHits.direct === afterProxyHits.direct + 1,
      proxyMarked: proxyValue.endsWith(":proxy"),
      inheritUnmarked: inheritValue.endsWith(":direct"),
    };
  }
}

/** A transferable service capability backed by the qualification DO's local store. */
export class PletivoBinding extends WorkerEntrypoint<
  Env,
  { nonce: string }
> implements QualificationBinding {
  #target(): DurableObjectStub<QualificationDO> {
    return this.env.QUALIFIER.getByName(this.ctx.props.nonce);
  }

  scan(ref: string, dir: string, pattern: string): Promise<ContentFileRef[]> {
    return this.#target().scan(ref, dir, pattern);
  }

  read(ref: string, path: string): Promise<string | null> {
    return this.#target().read(ref, path);
  }

  image(ref: string, path: string): Promise<ImageInfo | null> {
    return this.#target().image(ref, path);
  }

  fetch(request: Request): Promise<Response> {
    const headers = new Headers(request.headers);
    headers.set("x-pletivo-workerd-proxy", "1");
    return this.#target().fetch(new Request(request, { headers }));
  }
}

function requestString(object: object, name: string): string {
  const value = Reflect.get(object, name);
  if (typeof value !== "string" || value === "") throw new Error(`${name} must be a string`);
  return value;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ready") return new Response("ready");
    if (url.pathname !== "/qualify" || request.method !== "POST") {
      return new Response("Not Found", { status: 404 });
    }
    try {
      const value: unknown = await request.json();
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("qualification request must be an object");
      }
      const nonce = requestString(value, "nonce");
      const sidecar = requestString(value, "sidecar");
      const target = env.QUALIFIER.getByName(nonce);
      const report = await target.qualify(sidecar, nonce);
      return Response.json(report);
    } catch (error) {
      return new Response(error instanceof Error ? (error.stack ?? error.message) : String(error), {
        status: 500,
      });
    }
  },
};
