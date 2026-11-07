import { describe, expect, test } from "bun:test";
import { createAstroCompiler } from "../src/astro-compiler.ts";
import { createCompilerEntry } from "../src/compiler-isolate-entry.ts";
import { CompilerIsolateError, createIsolateAstroCompiler } from "../src/compiler-isolate.ts";
import { IsolateProtocolError } from "../src/isolate-protocol.ts";
import type { DynamicWorkerCode, WorkerLoaderBinding } from "../src/render.ts";
import { astroWasmModule } from "./astro-wasm.ts";
import { transformFields } from "./transform-fields.ts";

const astroWasm = await astroWasmModule();
const WASM_BYTES = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]).buffer;

/** A Loader whose isolate answers with `answer`; records what it was asked to create. */
function loaderAnswering(answer: (request: Request) => Promise<Response>) {
  const created: DynamicWorkerCode[] = [];
  const ids: string[] = [];
  const isolates = new Map<string, Promise<void>>();
  const loader: WorkerLoaderBinding = {
    get(id, code) {
      ids.push(id);
      if (!isolates.has(id)) isolates.set(id, Promise.resolve(code()).then((resolved) => void created.push(resolved)));
      return { getEntrypoint: () => ({ fetch: async (request) => (await isolates.get(id), answer(request)) }) };
    },
  };
  return { loader, created, ids };
}

function compilerOver(loader: WorkerLoaderBinding, tenant = "tests") {
  return createIsolateAstroCompiler({
    loader,
    namespace: { tenant, capabilityGeneration: "v1" },
    compatibilityDate: "2026-01-01",
    compatibilityFlags: ["nodejs_compat"],
    wasm: () => WASM_BYTES,
  });
}

const SOURCE =
  '---\nimport Card from "../components/Card.astro";\nconst title = "Compiled";\n---\n' +
  '<h1 class="title">{title}</h1>\n<Card client:load />\n<style>.title { color: red }</style>\n' +
  '<script>console.log("hoisted")</script>\n';
const OPTIONS = { filename: "/src/pages/index.astro", internalURL: "pletivo/astro-shim", sourcemap: false, annotateSourceFile: true };

describe("compiler isolate", () => {
  test("answers a transform and a parse as the compiler in this isolate does", async () => {
    const entry = createCompilerEntry(astroWasm);
    const { loader } = loaderAnswering((request) => entry.fetch(request));
    const isolated = compilerOver(loader);
    const local = createAstroCompiler(astroWasm);

    const transformed = await isolated.transform(SOURCE, OPTIONS);
    // Compared with the upstream result field by field, not through the reply's projection.
    const expected = await local.transform(SOURCE, { ...OPTIONS, resolvePath: async (specifier: string) => specifier });
    expect(expected.css.length).toBe(1);
    expect(expected.scripts.length).toBe(1);
    expect(expected.hydratedComponents.length).toBe(1);
    expect(transformed).toEqual(transformFields(expected));
    expect(transformed.code).not.toContain("$$createMetadata");
    expect(await isolated.parse(SOURCE, { position: true })).toEqual(await local.parse(SOURCE, { position: true }));
  });

  test("creates its isolate once, with the wasm next to the entry and no network", async () => {
    const entry = createCompilerEntry(astroWasm);
    const { loader, created, ids } = loaderAnswering((request) => entry.fetch(request));
    const isolated = compilerOver(loader);

    await isolated.transform("<p>a</p>", OPTIONS);
    await isolated.parse("<p>b</p>");

    expect(created).toHaveLength(1);
    expect(new Set(ids).size).toBe(1);
    const [code] = created;
    expect(code?.globalOutbound).toBeNull();
    expect(Object.values(code?.modules ?? {}).filter((module) => typeof module !== "string")).toEqual([{ wasm: WASM_BYTES }]);
  });

  test("gives each tenant its own isolate", async () => {
    const entry = createCompilerEntry(astroWasm);
    const { loader, ids } = loaderAnswering((request) => entry.fetch(request));
    await compilerOver(loader, "tenant-a").transform("<p>a</p>", OPTIONS);
    await compilerOver(loader, "tenant-b").transform("<p>a</p>", OPTIONS);
    expect(new Set(ids).size).toBe(2);
  });

  test("throws what the isolate reported as failed", async () => {
    const { loader } = loaderAnswering(async () => Response.json({ status: "error", message: "the compiler panicked", stack: "at go" }));
    const failure = await compilerOver(loader).transform("<p/>", OPTIONS).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CompilerIsolateError);
    expect(failure).toMatchObject({ message: "the compiler panicked", isolateStack: "at go" });
  });

  test("refuses a reply that does not have the shape of a transform result", async () => {
    const { loader } = loaderAnswering(async () => Response.json({ status: "transformed", result: { code: "export {}" } }));
    await expect(compilerOver(loader).transform("<p/>", OPTIONS)).rejects.toBeInstanceOf(IsolateProtocolError);
  });

  test("refuses a reply answering a different operation", async () => {
    const { loader } = loaderAnswering(async () => Response.json({ status: "parsed", ast: '{"type":"root","children":[]}', diagnostics: [] }));
    await expect(compilerOver(loader).transform("<p/>", OPTIONS)).rejects.toBeInstanceOf(IsolateProtocolError);
  });
});
