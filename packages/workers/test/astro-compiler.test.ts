import { describe, expect, test } from "bun:test";
import path from "node:path";
import { createAstroCompiler, compileAstro } from "../src/astro-compiler.ts";
import { collectAstroFiles } from "./compile-corpus.ts";
import { astroWasmModule, compile } from "./astro-wasm.ts";

const astroWasm = await astroWasmModule();

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const CORPUS_SCRIPT = path.join(import.meta.dir, "compile-corpus.ts");

/** The roots pletivo's own `.astro` behaviour is pinned against. */
const CORPUS_ROOTS = [
  "tests/fixture-astro-styles/src",
  "tests/fixture-astro-scripts/src",
  "tests/conformance/fixtures/css-cascade-order/src",
  "tests/fixture-astro-hoisted-imports",
  "examples/basic-astro/src",
];

async function corpusDigest(host: "node" | "workers"): Promise<Record<string, unknown>> {
  const proc = Bun.spawn(["bun", CORPUS_SCRIPT, `--host=${host}`, ...CORPUS_ROOTS], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`--host=${host} exited ${code}\n${stderr}`);
  return JSON.parse(stdout);
}

describe("astro compiler", () => {
  test("compiles a .astro source", async () => {
    const compiler = createAstroCompiler(astroWasm);
    const result = await compiler.transform('<h1 class="x">hi</h1>\n<style>h1 { color: red }</style>', {
      filename: "src/pages/index.astro",
      internalURL: "pletivo/astro-shim",
      sourcemap: false,
    });
    expect(result.diagnostics.filter((d) => d.severity === 1)).toEqual([]);
    expect(result.code).toContain('from "pletivo/astro-shim"');
    expect(result.scope).toMatch(/^[a-z0-9]+$/);
    expect(result.css).toEqual([`h1:where(.astro-${result.scope}){color:red}`]);
  });

  test("parses a .astro source into a root node", async () => {
    const compiler = createAstroCompiler(astroWasm);
    const { ast } = await compiler.parse("---\nconst a = 1;\n---\n<p>{a}</p>");
    expect(ast.type).toBe("root");
    expect(ast.children.length).toBeGreaterThan(0);
  });

  test("refuses a second WebAssembly.Module in the same isolate", async () => {
    const other = createAstroCompiler(await compile());
    await expect(other.transform("<p/>")).rejects.toThrow(/already running in this isolate/);
  });

  test("compileAstro() explains an unbundled astro.wasm rather than crashing", async () => {
    // Bun's loader resolves `.wasm` to a path; only wrangler's CompiledWasm rule
    // yields the module this entry point needs.
    await expect(compileAstro("<p/>")).rejects.toThrow(/did not resolve to a WebAssembly\.Module/);
  });

  test("matches @astrojs/compiler byte for byte across the .astro corpus", async () => {
    const files = await collectAstroFiles(CORPUS_ROOTS.map((r) => path.join(REPO_ROOT, r)));
    expect(files.length).toBeGreaterThan(20);

    const [reference, subject] = await Promise.all([corpusDigest("node"), corpusDigest("workers")]);
    expect(Object.keys(subject).length).toBe(files.length);
    for (const key of Object.keys(reference)) {
      expect(Reflect.get(reference[key] ?? {}, "failed")).toBeUndefined();
      expect({ [key]: subject[key] }).toEqual({ [key]: reference[key] });
    }
  }, 60_000);
});
