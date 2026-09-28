import { describe, expect, test } from "bun:test";
import type { ExecutableProgram, ResolvedStyleGraph } from "../src/compiled-program.ts";
import {
  ExecutionIdentityError,
  isolateKey,
  programHash,
  type IsolateKeyInput,
} from "../src/execution-identity.ts";
import {
  ISOLATE_PROTOCOL_VERSION,
  IsolateProtocolError,
  parseIsolateRequest,
  parseIsolateResponse,
  type IsolatePathsRequest,
  type IsolatePathsResponse,
  type IsolateErrorResponse,
  type IsolateRenderRequest,
  type IsolateRenderedResponse,
  type IsolateUnresolvedResponse,
} from "../src/isolate-protocol.ts";
import type { ResolvedModuleGraph } from "../src/module-graph.ts";

function renderEnvelope(overrides: Record<string, unknown> = {}): object {
  return {
    protocol: ISOLATE_PROTOCOL_VERSION,
    op: "render",
    file: "src/pages/[slug].astro",
    params: [["slug", "one"]],
    route: null,
    url: "https://example.test/one",
    ...overrides,
  };
}

function sparseParams(): unknown[] {
  const params: unknown[] = [];
  params.length = 1;
  return params;
}

function baseIdentity(program: string): IsolateKeyInput {
  return {
    programHash: program,
    namespace: { tenant: "tenant-a", capabilityGeneration: "generation-a" },
    platform: {
      hostAbi: "host-v1",
      compatibilityDate: "2026-08-12",
      compatibilityFlags: ["nodejs_compat", "flag-a"],
    },
    policy: {
      outbound: "blocked",
      env: {
        client: { PUBLIC_NAME: "one", PUBLIC_URL: "two" },
        server: { SECRET: "three", TOKEN: "four" },
      },
      importMetaEnv: { SITE: "five", MODE: "six" },
    },
  };
}

describe("execution identity", () => {
  test("program hash is stable across module insertion order", async () => {
    const left = await programHash({
      mainModule: "entry.js",
      modules: { "entry.js": "import './b.js'", "b.js": "export default 1" },
    });
    const right = await programHash({
      mainModule: "entry.js",
      modules: { "b.js": "export default 1", "entry.js": "import './b.js'" },
    });

    expect(left).toBe(right);
  });

  test("program hash covers main module, module name, and source", async () => {
    const baseline = await programHash({
      mainModule: "entry.js",
      modules: { "entry.js": "export default 1", "other.js": "export default 2" },
    });
    const changedMain = await programHash({
      mainModule: "other.js",
      modules: { "entry.js": "export default 1", "other.js": "export default 2" },
    });
    const changedName = await programHash({
      mainModule: "entry.js",
      modules: { "entry.js": "export default 1", "renamed.js": "export default 2" },
    });
    const changedSource = await programHash({
      mainModule: "entry.js",
      modules: { "entry.js": "export default 9", "other.js": "export default 2" },
    });

    expect(changedMain).not.toBe(baseline);
    expect(changedName).not.toBe(baseline);
    expect(changedSource).not.toBe(baseline);
  });

  test("isolate key is stable across record and flag insertion order", async () => {
    const baseline = baseIdentity("program-v1:abc");
    const reordered: IsolateKeyInput = {
      programHash: baseline.programHash,
      namespace: baseline.namespace,
      platform: {
        ...baseline.platform,
        compatibilityFlags: ["flag-a", "nodejs_compat"],
      },
      policy: {
        outbound: "blocked",
        env: {
          client: { PUBLIC_URL: "two", PUBLIC_NAME: "one" },
          server: { TOKEN: "four", SECRET: "three" },
        },
        importMetaEnv: { MODE: "six", SITE: "five" },
      },
    };

    expect(await isolateKey(reordered)).toBe(await isolateKey(baseline));
    expect(await isolateKey(baseline)).toBe(await isolateKey(baseline));
  });

  test("isolate key covers every immutable factory identity independently", async () => {
    const baseline = baseIdentity("program-v1:abc");
    const variants: Array<{ name: string; input: IsolateKeyInput }> = [
      {
        name: "tenant",
        input: { ...baseline, namespace: { ...baseline.namespace, tenant: "tenant-b" } },
      },
      {
        name: "capability generation",
        input: {
          ...baseline,
          namespace: { ...baseline.namespace, capabilityGeneration: "generation-b" },
        },
      },
      {
        name: "host ABI",
        input: { ...baseline, platform: { ...baseline.platform, hostAbi: "host-v2" } },
      },
      {
        name: "compatibility date",
        input: {
          ...baseline,
          platform: { ...baseline.platform, compatibilityDate: "2026-08-13" },
        },
      },
      {
        name: "compatibility flags",
        input: {
          ...baseline,
          platform: { ...baseline.platform, compatibilityFlags: ["nodejs_compat", "flag-b"] },
        },
      },
      {
        name: "outbound policy",
        input: { ...baseline, policy: { ...baseline.policy, outbound: "proxy" } },
      },
      {
        name: "astro env",
        input: {
          ...baseline,
          policy: {
            ...baseline.policy,
            env: {
              client: { PUBLIC_NAME: "changed", PUBLIC_URL: "two" },
              server: { SECRET: "three", TOKEN: "four" },
            },
          },
        },
      },
      {
        name: "server env",
        input: {
          ...baseline,
          policy: {
            ...baseline.policy,
            env: {
              client: { PUBLIC_NAME: "one", PUBLIC_URL: "two" },
              server: { SECRET: "changed", TOKEN: "four" },
            },
          },
        },
      },
      {
        name: "env presence",
        input: { ...baseline, policy: { ...baseline.policy, env: null } },
      },
      {
        name: "import meta env",
        input: {
          ...baseline,
          policy: {
            ...baseline.policy,
            importMetaEnv: { SITE: "changed", MODE: "six" },
          },
        },
      },
      {
        name: "import meta env presence",
        input: { ...baseline, policy: { ...baseline.policy, importMetaEnv: null } },
      },
    ];
    const key = await isolateKey(baseline);

    for (const variant of variants) {
      expect(await isolateKey(variant.input), variant.name).not.toBe(key);
    }
  });

  test("rejects missing namespace and platform identity", async () => {
    const baseline = baseIdentity("program-v1:abc");
    const invalid = [
      { ...baseline, namespace: { ...baseline.namespace, tenant: "" } },
      {
        ...baseline,
        namespace: { ...baseline.namespace, capabilityGeneration: "" },
      },
      { ...baseline, platform: { ...baseline.platform, hostAbi: "" } },
      { ...baseline, platform: { ...baseline.platform, compatibilityDate: "" } },
    ];

    for (const input of invalid) {
      await expect(isolateKey(input)).rejects.toBeInstanceOf(ExecutionIdentityError);
    }
  });

  test("distinguishes every outbound mode", async () => {
    const baseline = baseIdentity("program-v1:abc");
    const outboundModes: Array<"blocked" | "proxy" | "inherit"> = [
      "blocked",
      "proxy",
      "inherit",
    ];
    const keys = await Promise.all(
      outboundModes.map((outbound) =>
        isolateKey({ ...baseline, policy: { ...baseline.policy, outbound } }),
      ),
    );

    expect(new Set(keys).size).toBe(3);
  });

  test("rejects invalid outbound, flags, and module names", async () => {
    const baseline = baseIdentity("program-v1:abc");
    const invalidOutbound = JSON.parse(JSON.stringify(baseline));
    invalidOutbound.policy.outbound = "open";

    await expect(isolateKey(invalidOutbound)).rejects.toBeInstanceOf(ExecutionIdentityError);
    await expect(
      isolateKey({
        ...baseline,
        platform: { ...baseline.platform, compatibilityFlags: ["nodejs_compat", ""] },
      }),
    ).rejects.toBeInstanceOf(ExecutionIdentityError);
    await expect(
      isolateKey({
        ...baseline,
        platform: {
          ...baseline.platform,
          compatibilityFlags: ["nodejs_compat", "nodejs_compat"],
        },
      }),
    ).rejects.toBeInstanceOf(ExecutionIdentityError);
    await expect(
      programHash({ mainModule: "entry.js", modules: { "": "export {};" } }),
    ).rejects.toBeInstanceOf(ExecutionIdentityError);
  });
});

describe("isolate protocol", () => {
  test("round-trips render requests while preserving undefined params as null", () => {
    const request: IsolateRenderRequest = {
      protocol: ISOLATE_PROTOCOL_VERSION,
      op: "render",
      file: "src/pages/[...page].astro",
      params: [["page", null]],
      route: {
        file: "[...page].astro",
        segments: [{ type: "rest", value: "page" }],
        isDynamic: true,
        priority: 100,
        isEndpoint: false,
      },
      url: "https://example.test/",
      site: "https://example.test",
      contentRef: "render-1",
      rootDir: "",
    };

    expect(parseIsolateRequest(JSON.parse(JSON.stringify(request)))).toEqual(request);
  });

  test("round-trips paths requests", () => {
    const request: IsolatePathsRequest = {
      protocol: ISOLATE_PROTOCOL_VERSION,
      op: "paths",
      routes: [
        {
          file: "src/pages/[slug].astro",
          route: {
            file: "[slug].astro",
            segments: [{ type: "param", value: "slug" }],
            isDynamic: true,
            priority: 10,
            isEndpoint: false,
          },
        },
      ],
    };

    expect(parseIsolateRequest(JSON.parse(JSON.stringify(request)))).toEqual(request);
  });

  test("round-trips every response variant", () => {
    const rendered: IsolateRenderedResponse = {
      protocol: ISOLATE_PROTOCOL_VERSION,
      status: "rendered",
      html: "<p>ok</p>",
      renderedModules: ["project:src/pages/index.astro"],
      tsxStyles: ["p { color: red; }"],
    };
    const unresolved: IsolateUnresolvedResponse = {
      protocol: ISOLATE_PROTOCOL_VERSION,
      status: "unresolved",
      reason: "no-static-path",
    };
    const paths: IsolatePathsResponse = {
      protocol: ISOLATE_PROTOCOL_VERSION,
      status: "paths",
      paths: { "src/pages/[slug].astro": [[ ["slug", "one"] ]] },
    };
    const error: IsolateErrorResponse = {
      protocol: ISOLATE_PROTOCOL_VERSION,
      status: "error",
      message: "render failed",
      stack: "stack",
    };

    for (const response of [rendered, unresolved, paths, error]) {
      expect(parseIsolateResponse(JSON.parse(JSON.stringify(response)))).toEqual(response);
    }
  });

  test("rejects malformed request envelopes", () => {
    const malformed: Array<{ name: string; value: unknown }> = [
      {
        name: "wrong version",
        value: renderEnvelope({ protocol: ISOLATE_PROTOCOL_VERSION + 1 }),
      },
      { name: "unknown variant", value: { protocol: ISOLATE_PROTOCOL_VERSION, op: "inspect" } },
      { name: "unknown field", value: renderEnvelope({ extra: true }) },
      {
        name: "missing field",
        value: {
          protocol: ISOLATE_PROTOCOL_VERSION,
          op: "render",
          file: "src/pages/index.astro",
          params: [],
          route: null,
        },
      },
      { name: "half content fields", value: renderEnvelope({ contentRef: "render-1" }) },
      {
        name: "duplicate params",
        value: renderEnvelope({ params: [["slug", "one"], ["slug", "two"]] }),
      },
      { name: "sparse params", value: renderEnvelope({ params: sparseParams() }) },
      {
        name: "bad segment",
        value: renderEnvelope({
          route: {
            file: "[slug].astro",
            segments: [{ type: "wildcard", value: "slug" }],
            isDynamic: true,
            priority: 10,
            isEndpoint: false,
          },
        }),
      },
      {
        name: "bad priority",
        value: renderEnvelope({
          route: {
            file: "[slug].astro",
            segments: [{ type: "param", value: "slug" }],
            isDynamic: true,
            priority: Number.POSITIVE_INFINITY,
            isEndpoint: false,
          },
        }),
      },
    ];

    for (const scenario of malformed) {
      expect(() => parseIsolateRequest(scenario.value), scenario.name).toThrow(
        IsolateProtocolError,
      );
    }
  });

  test("rejects malformed response envelopes and reserved path keys", () => {
    const malformed: Array<{ name: string; value: unknown }> = [
      {
        name: "unknown variant",
        value: { protocol: ISOLATE_PROTOCOL_VERSION, status: "redirect" },
      },
      {
        name: "missing rendered field",
        value: {
          protocol: ISOLATE_PROTOCOL_VERSION,
          status: "rendered",
          renderedModules: [],
          tsxStyles: [],
        },
      },
      {
        name: "bad unresolved reason",
        value: {
          protocol: ISOLATE_PROTOCOL_VERSION,
          status: "unresolved",
          reason: "redirected",
        },
      },
      {
        name: "malformed paths",
        value: {
          protocol: ISOLATE_PROTOCOL_VERSION,
          status: "paths",
          paths: { "src/pages/[slug].astro": ["not-param-sets"] },
        },
      },
      {
        name: "empty error message",
        value: { protocol: ISOLATE_PROTOCOL_VERSION, status: "error", message: "" },
      },
      {
        name: "proto path",
        value: JSON.parse(
          `{"protocol":${ISOLATE_PROTOCOL_VERSION},"status":"paths","paths":{"__proto__":[]}}`,
        ),
      },
      {
        name: "prototype path",
        value: {
          protocol: ISOLATE_PROTOCOL_VERSION,
          status: "paths",
          paths: { prototype: [] },
        },
      },
      {
        name: "constructor path",
        value: {
          protocol: ISOLATE_PROTOCOL_VERSION,
          status: "paths",
          paths: { constructor: [] },
        },
      },
    ];

    for (const scenario of malformed) {
      expect(() => parseIsolateResponse(scenario.value), scenario.name).toThrow(
        IsolateProtocolError,
      );
    }
  });
});

describe("compiler DTO boundaries", () => {
  test("keeps logical, compilation, and execution identities separate", () => {
    const graph: ResolvedModuleGraph = {
      modules: [
        {
          identity: {
            id: "artifact:widget/component.astro",
            compilePath: "node_modules/widget/component.astro",
            executionName: "artifact.widget.component.js",
          },
          kind: "astro",
          source: "<p>widget</p>",
        },
      ],
      edges: [],
    };
    const program: ExecutableProgram = {
      mainModule: "pletivo-entry.js",
      modules: { "artifact.widget.component.js": "export default function () {}" },
      entries: [
        {
          moduleId: "artifact:widget/component.astro",
          executionName: "artifact.widget.component.js",
        },
      ],
      requirements: { content: null, images: false, importMetaEnv: false, env: null },
    };
    const styles: ResolvedStyleGraph = {
      modules: ["artifact:widget/component.astro"],
      executionEdges: [],
      styleEdges: [],
      styles: [],
    };

    expect(graph.modules[0]?.identity.id).toBe("artifact:widget/component.astro");
    expect(graph.modules[0]?.identity.compilePath).toBe("node_modules/widget/component.astro");
    expect(graph.modules[0]?.identity.executionName).toBe("artifact.widget.component.js");
    expect(program.entries[0]?.moduleId).toBe(styles.modules[0]);
  });
});
