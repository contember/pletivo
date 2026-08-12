import { afterAll, describe, expect, test } from "bun:test";
import { createAstroCompiler } from "../src/astro-compiler.ts";
import { outboundConfig, type OutboundBinding } from "../src/outbound.ts";
import {
  renderPage,
  type DynamicWorkerCode,
  type DynamicWorkerStub,
  type WorkerLoaderBinding,
} from "../src/render.ts";
import { astroWasmModule } from "./astro-wasm.ts";
import { FileLoader } from "./file-loader.ts";

/**
 * What the isolate is allowed to reach, on the host side of the boundary.
 *
 * `FileLoader` imports the bundle into this process, so it cannot *enforce*
 * `globalOutbound` — a `fetch()` in a page would reach the real network here, which
 * is why no page in this file has one. What is checked here is the code object handed
 * to the Loader, and the id it is cached under, because that is where the decision is
 * made. `test/outbound.ts` is the other half: the same configurations in real
 * workerd, where the field is enforced.
 */

const compiler = createAstroCompiler(await astroWasmModule());
const fileLoaders: FileLoader[] = [];
afterAll(() => Promise.all(fileLoaders.map((loader) => loader.cleanup())));

/** Remembers what was asked of the Loader, which is the whole subject here. */
class RecordingLoader implements WorkerLoaderBinding {
  readonly ids: string[] = [];
  readonly codes = new Map<string, DynamicWorkerCode>();
  readonly inner = new FileLoader();

  constructor() {
    fileLoaders.push(this.inner);
  }

  get(id: string, code: () => DynamicWorkerCode | Promise<DynamicWorkerCode>): DynamicWorkerStub {
    this.ids.push(id);
    return this.inner.get(id, async () => {
      const built = await code();
      this.codes.set(id, built);
      return built;
    });
  }

  /** The id the render that just finished was cached under. */
  get lastId(): string {
    const id = this.ids[this.ids.length - 1];
    if (id === undefined) throw new Error("no isolate was asked for");
    return id;
  }

  get lastCode(): DynamicWorkerCode {
    const code = this.codes.get(this.lastId);
    if (code === undefined) throw new Error(`no code was built for ${this.lastId}`);
    return code;
  }
}

const SITE = new Map<string, string>([
  [
    "src/pages/index.astro",
    `---
import { TOKEN } from "astro:env/server";
const site = import.meta.env.SITE;
void TOKEN;
void site;
---
<html><body><p>page</p></body></html>
`,
  ],
]);

/** The stub a proxying host would hand over. Never called: nothing here fetches. */
const binding: OutboundBinding = {
  fetch: () => Promise.resolve(new Response("proxied")),
};

function render(
  loader: RecordingLoader,
  outbound?: Parameters<typeof renderPage>[0]["outbound"],
  options: Pick<
    Parameters<typeof renderPage>[0],
    "compatibilityDate" | "compatibilityFlags" | "env" | "executionNamespace" | "importMetaEnv"
  > = {},
) {
  return renderPage({ files: SITE, pathname: "/", loader, compiler, outbound, ...options });
}

describe("globalOutbound", () => {
  test("is null when the caller says nothing, so a page reaches nothing", async () => {
    const loader = new RecordingLoader();
    await render(loader);
    // Present *and* null. An absent field is the one value that inherits the host
    // worker's own network access, so the presence is half the assertion.
    expect("globalOutbound" in loader.lastCode).toBe(true);
    expect(loader.lastCode.globalOutbound).toBe(null);
  });

  test("is null when the caller says so out loud", async () => {
    const loader = new RecordingLoader();
    await render(loader, { kind: "blocked" });
    expect(loader.lastCode.globalOutbound).toBe(null);
  });

  test("is the binding the caller passed, and only then", async () => {
    const loader = new RecordingLoader();
    await render(loader, { kind: "proxy", binding }, {
      executionNamespace: { tenant: "outbound-tests", capabilityGeneration: "proxy-v1" },
    });
    expect(loader.lastCode.globalOutbound).toBe(binding);
  });

  test("is left out only for an explicit inherit", async () => {
    const loader = new RecordingLoader();
    await render(loader, { kind: "inherit" });
    expect("globalOutbound" in loader.lastCode).toBe(false);
  });
});

describe("outboundConfig", () => {
  test("omits the field for inherit and nothing else", () => {
    expect(outboundConfig(undefined)).toEqual({ globalOutbound: null });
    expect(outboundConfig({ kind: "blocked" })).toEqual({ globalOutbound: null });
    expect(outboundConfig({ kind: "proxy", binding })).toEqual({ globalOutbound: binding });
    expect("globalOutbound" in outboundConfig({ kind: "inherit" })).toBe(false);
  });
});

describe("the isolate cache key", () => {
  test("returns the program hash while caching under the full isolate identity", async () => {
    const loader = new RecordingLoader();
    const page = await render(loader);
    expect(loader.lastId).not.toBe(page.bundleId);
    expect(page.bundleId).toStartWith("program-v1:");
    expect(loader.lastId).toStartWith("isolate-v1:");
  });

  test("separates a proxied isolate from a cut-off one over the same sources", async () => {
    // `env.LOADER.get` runs its code factory once per id, so an id that ignored the
    // outbound configuration would hand whichever render came second the network
    // policy of the one that came first.
    const loader = new RecordingLoader();
    const cutOff = await render(loader);
    const cutOffId = loader.lastId;
    const proxied = await render(loader, { kind: "proxy", binding }, {
      executionNamespace: { tenant: "outbound-tests", capabilityGeneration: "proxy-v1" },
    });
    expect(proxied.bundleId).toBe(cutOff.bundleId);
    expect(loader.lastId).not.toBe(cutOffId);
  });

  test("is stable for one configuration, so a proxy does not mint an isolate per render", async () => {
    const loader = new RecordingLoader();
    for (let n = 0; n < 3; n++) {
      // A fresh stub every render, the way `ctx.exports.X({})` gives one.
      await render(loader, { kind: "proxy", binding: { fetch: binding.fetch } }, {
        executionNamespace: { tenant: "outbound-tests", capabilityGeneration: "proxy-v1" },
      });
    }
    expect(new Set(loader.ids).size).toBe(1);
    expect(loader.inner.factoryCounts.get(loader.lastId)).toBe(1);
  });

  test("partitions every immutable factory input", async () => {
    const loader = new RecordingLoader();
    const namespace = { tenant: "tenant-a", capabilityGeneration: "cap-v1" };
    await render(loader, undefined, { executionNamespace: namespace });
    const baseline = loader.lastId;

    const variants = [
      { executionNamespace: { tenant: "tenant-b", capabilityGeneration: "cap-v1" } },
      { executionNamespace: { tenant: "tenant-a", capabilityGeneration: "cap-v2" } },
      { executionNamespace: namespace, compatibilityDate: "2026-02-01" },
      { executionNamespace: namespace, compatibilityFlags: ["nodejs_compat", "streams_enable_constructors"] },
      { executionNamespace: namespace, env: { server: { TOKEN: "changed" } } },
      { executionNamespace: namespace, importMetaEnv: { SITE: "changed" } },
    ];
    for (const variant of variants) {
      await render(loader, undefined, variant);
      expect(loader.lastId).not.toBe(baseline);
    }

    await render(loader, undefined, { executionNamespace: namespace });
    expect(loader.lastId).toBe(baseline);
  });

  test("rejects proxy capability use before asking the Loader when namespace is absent", async () => {
    const loader = new RecordingLoader();
    await expect(render(loader, { kind: "proxy", binding })).rejects.toThrow(/executionNamespace/);
    expect(loader.ids).toEqual([]);
  });
});
