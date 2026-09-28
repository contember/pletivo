import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  DynamicWorkerCode,
  DynamicWorkerStub,
  WorkerLoaderBinding,
} from "../src/render.ts";
import { programHash } from "../src/execution-identity.ts";

/**
 * A Worker Loader that runs the module bundle on Bun instead of in workerd.
 *
 * The bundle is written to a temp directory and its main module imported, which is
 * as close as `bun test` can get to `env.LOADER`: the modules, their relative
 * specifiers and the entry's `fetch` contract are all exercised for real. What it
 * cannot show is anything workerd does differently — no `eval`, its own module
 * registry, `nodejs_compat`. That is what `test/parity.ts` against `wrangler dev`
 * is for.
 */
export class FileLoader implements WorkerLoaderBinding {
  readonly bundles = new Map<string, DynamicWorkerCode>();
  readonly programs = new Map<string, DynamicWorkerCode>();
  readonly getCounts = new Map<string, number>();
  readonly factoryCounts = new Map<string, number>();
  #roots: string[] = [];
  #entries = new Map<string, Promise<{ fetch(request: Request): Promise<Response> }>>();

  get(id: string, code: () => DynamicWorkerCode | Promise<DynamicWorkerCode>): DynamicWorkerStub {
    this.getCounts.set(id, (this.getCounts.get(id) ?? 0) + 1);
    const load = async (): Promise<{ fetch(request: Request): Promise<Response> }> => {
      this.factoryCounts.set(id, (this.factoryCounts.get(id) ?? 0) + 1);
      const bundle = await code();
      this.bundles.set(id, bundle);
      this.programs.set(
        await programHash({ mainModule: bundle.mainModule, modules: bundle.modules }),
        bundle,
      );
      const root = await fs.mkdtemp(path.join(os.tmpdir(), `pletivo-loader-${id}-`));
      this.#roots.push(root);
      for (const [name, source] of Object.entries(bundle.modules)) {
        const file = path.join(root, name);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, source);
      }
      const entry: unknown = await import(path.join(root, bundle.mainModule));
      const handler =
        typeof entry === "object" && entry !== null ? Reflect.get(entry, "default") : undefined;
      if (typeof handler !== "object" || handler === null) {
        throw new Error(`${bundle.mainModule} has no default export`);
      }
      const fetchHandler = Reflect.get(handler, "fetch");
      if (typeof fetchHandler !== "function") {
        throw new Error(`${bundle.mainModule} default export has no fetch()`);
      }
      // `env` is the second argument a Worker's fetch takes, and the content binding
      // arrives that way — so it has to be handed over here too, or the collection
      // path would only ever be exercised in workerd.
      return {
        fetch: (request) => Promise.resolve(fetchHandler.call(handler, request, bundle.env)),
      };
    };
    let entry = this.#entries.get(id);
    if (entry === undefined) {
      entry = load();
      this.#entries.set(id, entry);
    }
    const cachedEntry = entry;
    return {
      getEntrypoint: () => ({
        fetch: async (request: Request) => (await cachedEntry).fetch(request),
      }),
    };
  }

  async cleanup(): Promise<void> {
    for (const root of this.#roots) await fs.rm(root, { recursive: true, force: true });
    this.#roots = [];
    this.#entries.clear();
    this.bundles.clear();
    this.programs.clear();
    this.getCounts.clear();
    this.factoryCounts.clear();
  }
}
