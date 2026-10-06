import { describe, expect, test } from "bun:test";
import {
  ExecutionIdentityError,
  isolateKey,
  programHash,
  type IsolateKeyInput,
} from "../src/execution-identity.ts";
import {
  IsolateProtocolError,
  parseIsolateResponse,
  type IsolatePathsResponse,
  type IsolateErrorResponse,
  type IsolateRenderedResponse,
  type IsolateUnresolvedResponse,
} from "../src/isolate-protocol.ts";

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

describe("isolate response boundary", () => {
  test("round-trips every response variant", () => {
    const rendered: IsolateRenderedResponse = {
      status: "rendered",
      html: "<p>ok</p>",
      renderedModules: ["project:src/pages/index.astro"],
      tsxStyles: ["p { color: red; }"],
    };
    const unresolved: IsolateUnresolvedResponse = { status: "unresolved", reason: "no-static-path" };
    const paths: IsolatePathsResponse = {
      status: "paths",
      paths: { "src/pages/[slug].astro": [[["slug", "one"]], [["slug", null]]] },
    };
    const error: IsolateErrorResponse = { status: "error", message: "render failed", stack: "stack" };

    for (const response of [rendered, unresolved, paths, error]) {
      expect(parseIsolateResponse(JSON.parse(JSON.stringify(response)))).toEqual(response);
    }
  });

  test("rejects malformed responses", () => {
    const malformed: Array<{ name: string; value: unknown }> = [
      { name: "not an object", value: "rendered" },
      { name: "unknown status", value: { status: "redirect" } },
      { name: "missing html", value: { status: "rendered", renderedModules: [], tsxStyles: [] } },
      {
        name: "non-string html",
        value: { status: "rendered", html: 1, renderedModules: [], tsxStyles: [] },
      },
      {
        name: "non-string rendered module",
        value: { status: "rendered", html: "", renderedModules: [1], tsxStyles: [] },
      },
      { name: "bad unresolved reason", value: { status: "unresolved", reason: "redirected" } },
      {
        name: "malformed paths",
        value: { status: "paths", paths: { "src/pages/[slug].astro": ["not-param-sets"] } },
      },
      { name: "missing error message", value: { status: "error" } },
    ];

    for (const scenario of malformed) {
      expect(() => parseIsolateResponse(scenario.value), scenario.name).toThrow(
        IsolateProtocolError,
      );
    }
  });

  test("keeps a __proto__ path key as data", () => {
    const response = parseIsolateResponse(JSON.parse('{"status":"paths","paths":{"__proto__":[]}}'));
    if (response.status !== "paths") throw new Error("expected paths");
    expect(Object.getPrototypeOf(response.paths)).toBe(Object.prototype);
    expect(Object.keys(response.paths)).toEqual(["__proto__"]);
  });
});
