/**
 * The seam a Durable Object composes: a store that reads a project, and a host that
 * serves it. Both exercised without a Durable Object under them, which is the point of
 * the split — `example-workspace/` wires the same two objects to a real workspace.
 */

import { afterAll, describe, expect, test } from "bun:test";
import type {
  ParseOptions,
  ParseResult,
  TransformOptions,
  TransformResult,
} from "@astrojs/compiler/types";
import { createAstroCompiler, type AstroCompiler } from "../src/astro-compiler.ts";
import { createProjectHost } from "../src/project-host.ts";
import { createMapProjectStore, type ProjectStore } from "../src/project-store.ts";
import {
  createWorkspaceProjectStore,
  vfsRevision,
  type WorkspaceDirent,
  type WorkspaceFiles,
} from "../src/workspace-store.ts";
import { astroWasmModule } from "./astro-wasm.ts";
import { FileLoader } from "./file-loader.ts";

const compiler = createAstroCompiler(await astroWasmModule());
const loader = new FileLoader();
afterAll(() => loader.cleanup());

const PAGE = `---
const title = "Home";
---
<html lang="en"><head><title>{title}</title></head><body><h1>{title}</h1></body></html>
<style>h1 { color: rebeccapurple; }</style>
`;

/** A workspace held in plain objects: directory path -> its entries. */
class FakeWorkspace implements WorkspaceFiles {
  readonly reads: string[] = [];
  #revision = 1;
  readonly #text = new Map<string, string>();
  readonly #bytes = new Map<string, Uint8Array>();

  write(path: string, content: string | Uint8Array): void {
    if (typeof content === "string") this.#text.set(path, content);
    else this.#bytes.set(path, content);
    this.#revision++;
  }

  get revision(): number {
    return this.#revision;
  }

  #paths(): string[] {
    return [...this.#text.keys(), ...this.#bytes.keys()];
  }

  readdirSync(path: string, options?: { withFileTypes?: boolean }): string[] | WorkspaceDirent[] {
    if (options?.withFileTypes !== true) throw new Error("the store must ask for file types");
    const prefix = path === "/" ? "/" : `${path}/`;
    const names = new Map<string, boolean>();
    for (const file of this.#paths()) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash === -1) names.set(rest, false);
      else names.set(rest.slice(0, slash), true);
    }
    return [...names].map(([name, isDirectory]) => ({
      name,
      isFile: () => !isDirectory,
      isDirectory: () => isDirectory,
    }));
  }

  readFileSync(path: string, options?: { encoding?: string | null } | string | null): unknown {
    this.reads.push(path);
    const text = this.#text.get(path);
    if (text !== undefined) return options ? text : new TextEncoder().encode(text);
    const bytes = this.#bytes.get(path);
    if (bytes !== undefined) return options ? new TextDecoder().decode(bytes) : bytes;
    throw Object.assign(new Error(`no such file: ${path}`), { code: "ENOENT" });
  }

  statSync(path: string): { size: number } {
    const text = this.#text.get(path);
    if (text !== undefined) return { size: new TextEncoder().encode(text).byteLength };
    const bytes = this.#bytes.get(path);
    if (bytes !== undefined) return { size: bytes.byteLength };
    throw Object.assign(new Error(`no such file: ${path}`), { code: "ENOENT" });
  }

  existsSync(path: string): boolean {
    return this.#text.has(path) || this.#bytes.has(path);
  }
}

function hostOf(store: ProjectStore) {
  return createProjectHost({ store, loader, compiler });
}

/** The compiler, with the filename of every `transform` recorded. */
function countingCompiler(): { compiler: AstroCompiler; transformed: string[] } {
  const transformed: string[] = [];
  return {
    transformed,
    compiler: {
      transform(source: string, options?: TransformOptions): Promise<TransformResult> {
        transformed.push(options?.filename ?? "");
        return compiler.transform(source, options);
      },
      parse(source: string, options?: ParseOptions): Promise<ParseResult> {
        return compiler.parse(source, options);
      },
    },
  };
}

describe("createWorkspaceProjectStore", () => {
  test("walks the tree under the root and keys files relative to it", async () => {
    const workspace = new FakeWorkspace();
    workspace.write("/project/src/pages/index.astro", PAGE);
    workspace.write("/project/src/styles/site.css", "body { margin: 0 }");
    workspace.write("/project/package.json", `{"name":"demo"}`);
    workspace.write("/elsewhere/ignored.astro", PAGE);

    const store = createWorkspaceProjectStore(workspace, {
      root: "/project",
      revision: () => workspace.revision,
    });
    const { files } = await store.snapshot();

    expect([...files.keys()].sort()).toEqual([
      "package.json",
      "src/pages/index.astro",
      "src/styles/site.css",
    ]);
  });

  test("reads images as bytes rather than text", async () => {
    const workspace = new FakeWorkspace();
    workspace.write("/src/pages/index.astro", PAGE);
    // A one-pixel GIF, which is bytes no decoder would round-trip.
    workspace.write("/src/hero.gif", new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00]));

    const store = createWorkspaceProjectStore(workspace, { revision: () => workspace.revision });
    const { files, assets } = await store.snapshot();

    expect(files.has("src/hero.gif")).toBe(false);
    expect(assets.get("src/hero.gif")).toBeInstanceOf(Uint8Array);
  });

  test("skips node_modules and the other build directories", async () => {
    const workspace = new FakeWorkspace();
    workspace.write("/src/pages/index.astro", PAGE);
    workspace.write("/node_modules/preact/index.js", "export default 1;");
    workspace.write("/dist/index.html", "<html></html>");

    const store = createWorkspaceProjectStore(workspace, { revision: () => workspace.revision });
    const { files } = await store.snapshot();

    expect([...files.keys()]).toEqual(["src/pages/index.astro"]);
  });

  test("leaves out a file over maxFileBytes rather than reading it", async () => {
    const workspace = new FakeWorkspace();
    workspace.write("/src/pages/index.astro", PAGE);
    workspace.write("/src/huge.json", "x".repeat(2048));

    const store = createWorkspaceProjectStore(workspace, {
      revision: () => workspace.revision,
      maxFileBytes: 1024,
    });
    const { files } = await store.snapshot();

    expect(files.has("src/huge.json")).toBe(false);
    expect(workspace.reads).not.toContain("/src/huge.json");
  });

  describe("the revision gate", () => {
    test("an unchanged workspace is not read twice, and hands back the same maps", async () => {
      const workspace = new FakeWorkspace();
      workspace.write("/src/pages/index.astro", PAGE);
      const store = createWorkspaceProjectStore(workspace, { revision: () => workspace.revision });

      const first = await store.snapshot();
      const readsAfterFirst = workspace.reads.length;
      const second = await store.snapshot();

      expect(workspace.reads.length).toBe(readsAfterFirst);
      // The same object, so a caller that already walked this snapshot can tell it did.
      // The compile cache does not need this — an equal source hits either way — but it
      // is why an unchanged workspace costs one SQL lookup. See project-store.ts.
      expect(second.files).toBe(first.files);
      expect(second.files.get("src/pages/index.astro")).toBe(
        first.files.get("src/pages/index.astro"),
      );
    });

    test("a write is picked up", async () => {
      const workspace = new FakeWorkspace();
      workspace.write("/src/pages/index.astro", PAGE);
      const store = createWorkspaceProjectStore(workspace, { revision: () => workspace.revision });

      await store.snapshot();
      workspace.write("/src/pages/about.astro", "<html><body><p>about</p></body></html>\n");
      const after = await store.snapshot();

      expect([...after.files.keys()].sort()).toEqual([
        "src/pages/about.astro",
        "src/pages/index.astro",
      ]);
    });

    test("without a revision source nothing is reused", async () => {
      const workspace = new FakeWorkspace();
      workspace.write("/src/pages/index.astro", PAGE);
      const store = createWorkspaceProjectStore(workspace);

      const first = await store.snapshot();
      const second = await store.snapshot();

      // Correct, and exactly as slow as having no store: a workspace that will not say
      // whether it changed has to be re-read.
      expect(second.files).not.toBe(first.files);
      expect([...second.files.keys()]).toEqual([...first.files.keys()]);
    });
  });

  test("vfsRevision degrades to undefined when the schema is not there", () => {
    const missing = vfsRevision({
      one: () => {
        throw new Error("no such table: vfs_meta");
      },
    });
    const present = vfsRevision({ one: () => ({ v: 42 }) });

    expect(missing()).toBeUndefined();
    expect(present()).toBe("42");
  });
});

describe("createProjectHost", () => {
  test("renders a page out of the store", async () => {
    const host = hostOf(createMapProjectStore(new Map([["src/pages/index.astro", PAGE]])));

    const response = await host.fetch(new Request("https://example.test/"));

    expect(response.status).toBe(200);
    expect(response.headers.get("x-pletivo-page")).toBe("src/pages/index.astro");
    expect(await response.text()).toContain("<h1");
  });

  test("serves the file the page it just rendered links to", async () => {
    // A `?url` import, since the page's CSS is inlined and no longer a file anyone has
    // to fetch. This is the only thing left that fills the host's asset map, so it is
    // the only thing that can cover it.
    const host = hostOf(
      createMapProjectStore(
        new Map([
          [
            "src/pages/index.astro",
            '---\nimport formUrl from "../scripts/form.js?url";\n---\n' +
              "<html><head><title>t</title></head><body><script src={formUrl}></script></body></html>\n",
          ],
          ["src/scripts/form.js", "console.log('form');\n"],
        ]),
      ),
    );

    const html = await (await host.fetch(new Request("https://example.test/"))).text();
    const src = /src="([^"]+\.js)"/.exec(html)?.[1];
    expect(src).toBeString();

    const asset = await host.fetch(new Request(`https://example.test${src}`));
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toStartWith("text/javascript");
    expect(await asset.text()).toBe("console.log('form');\n");
  });

  test("inlines the page's CSS instead of linking a stylesheet to serve", async () => {
    const host = hostOf(
      createMapProjectStore(
        new Map([
          ["src/pages/index.astro", PAGE],
          ["src/styles/site.css", "body { background: papayawhip; }"],
        ]),
      ),
    );

    const html = await (await host.fetch(new Request("https://example.test/"))).text();

    expect(html).toContain("papayawhip");
    expect(html).not.toContain('<link rel="stylesheet"');
  });

  test("an unknown pathname is a 404, not a throw", async () => {
    const host = hostOf(createMapProjectStore(new Map([["src/pages/index.astro", PAGE]])));

    const response = await host.fetch(new Request("https://example.test/nope"));

    expect(response.status).toBe(404);
  });

  test("a workspace write shows up in the next render", async () => {
    const workspace = new FakeWorkspace();
    workspace.write("/src/pages/index.astro", PAGE);
    const host = hostOf(
      createWorkspaceProjectStore(workspace, { revision: () => workspace.revision }),
    );

    expect((await host.fetch(new Request("https://example.test/about"))).status).toBe(404);
    workspace.write("/src/pages/about.astro", "<html><body><p>about</p></body></html>\n");
    const response = await host.fetch(new Request("https://example.test/about"));

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("about");
  });

  /**
   * The revision gate and the compile cache are only useful together — the gate hands
   * back the sources a hit is decided on, and nothing else tests the joint.
   */
  describe("the compile cache the host owns", () => {
    const LAYOUT = `---\nconst year = 2026;\n---\n<html><body><slot />{year}</body></html>\n<style>body { margin: 0; }</style>\n`;
    const HOME = `---\nimport Layout from "../components/Layout.astro";\n---\n<Layout><h1>home</h1></Layout>\n`;

    function workspaceHost() {
      const workspace = new FakeWorkspace();
      workspace.write("/src/pages/index.astro", HOME);
      workspace.write("/src/components/Layout.astro", LAYOUT);
      const counting = countingCompiler();
      const host = createProjectHost({
        store: createWorkspaceProjectStore(workspace, { revision: () => workspace.revision }),
        loader,
        compiler: counting.compiler,
      });
      return { workspace, host, transformed: counting.transformed };
    }

    test("a second render of an unchanged workspace transforms nothing", async () => {
      const { host, transformed } = workspaceHost();

      await host.fetch(new Request("https://example.test/"));
      expect(transformed).toEqual(["src/pages/index.astro", "src/components/Layout.astro"]);

      transformed.length = 0;
      const again = await host.fetch(new Request("https://example.test/"));

      expect(again.status).toBe(200);
      expect(transformed).toEqual([]);
    });

    test("a write re-transforms only the file written", async () => {
      const { workspace, host, transformed } = workspaceHost();
      await host.fetch(new Request("https://example.test/"));

      workspace.write(
        "/src/components/Layout.astro",
        `<html><body><slot /></body></html>\n<style>body { margin: 1px; }</style>\n`,
      );
      transformed.length = 0;
      const response = await host.fetch(new Request("https://example.test/"));

      expect(transformed).toEqual(["src/components/Layout.astro"]);
      expect(await response.text()).toContain("margin:1px");
    });
  });

  test("paths() enumerates the project's pages", async () => {
    const host = hostOf(
      createMapProjectStore(
        new Map([
          ["src/pages/index.astro", PAGE],
          ["src/pages/about.astro", "<html><body><p>about</p></body></html>\n"],
        ]),
      ),
    );

    const paths = await host.paths();

    expect(paths.map((path) => path.pathname).sort()).toEqual(["/", "/about/"]);
  });
});
