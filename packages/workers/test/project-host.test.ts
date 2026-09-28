/**
 * The seam a Durable Object composes: a store that reads a project, and a host that
 * serves it. Both exercised without a Durable Object under them, which is the point of
 * the split — `example-playground/` wires the same two objects to a real workspace.
 */

import { afterAll, describe, expect, spyOn, test } from "bun:test";
import {
  ARTIFACT_VERSION,
  ArtifactVersionError,
  digestArtifactInput,
} from "@pletivo/core/artifact";
import { UnsupportedArtifactExternalError } from "../src/artifact.ts";
import type {
  ParseOptions,
  ParseResult,
  TransformOptions,
  TransformResult,
} from "@astrojs/compiler/types";
import { createAstroCompiler, type AstroCompiler } from "../src/astro-compiler.ts";
import { ContentFiles, createProjectAssetsView, probeImage } from "../src/content-files.ts";
import {
  createProjectHost,
  GeneratedAssetRetentionError,
  ProjectArtifactError,
} from "../src/project-host.ts";
import { createMapProjectStore, type ProjectStore } from "../src/project-store.ts";
import {
  createWorkspaceProjectStore,
  WorkspaceSnapshotChangedError,
  type WorkspaceDirent,
  type WorkspaceFiles,
} from "../src/workspace-store.ts";
import { astroWasmModule } from "./astro-wasm.ts";
import { FileLoader } from "./file-loader.ts";
import { tailwindDir, tailwindStylesheets } from "./tailwind-sources.ts";

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
  onRead: ((path: string) => void) | undefined;
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
    this.onRead?.(path);
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
    workspace.write(
      "/src/hero.gif",
      Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="), (char) =>
        char.charCodeAt(0),
      ),
    );

    const store = createWorkspaceProjectStore(workspace, { revision: () => workspace.revision });
    const { files, assets } = await store.snapshot();

    expect(files.has("src/hero.gif")).toBe(false);
    const info = await assets.info("src/hero.gif");
    expect(info?.format).toBe("gif");
    const output = `/_astro/hero.${info?.hash}.gif`;
    expect((await assets.resolveOutput(output))?.bytes).toBeInstanceOf(Uint8Array);
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

  test("does not probe unrelated images during an ordinary page fetch", async () => {
    let probes = 0;
    const bytes = Uint8Array.from(
      atob("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="),
      (char) => char.charCodeAt(0),
    );
    const assets = createProjectAssetsView(
      new Map([["src/assets/hero.gif", bytes]]),
      (source, path) => {
        probes++;
        return probeImage(source, path);
      },
    );
    const host = hostOf(
      createMapProjectStore(new Map([["src/pages/index.astro", PAGE]]), assets),
    );

    expect((await host.fetch(new Request("https://example.test/"))).status).toBe(200);
    expect(probes).toBe(0);
  });

  test("returns known metadata-only image output as 404 without rendering a page", async () => {
    const host = hostOf(
      createMapProjectStore(
        new Map([["src/pages/index.astro", `---\nthrow new Error("page ran");\n---\n<p>x</p>\n`]]),
        new Map([
          [
            "src/assets/hero.png",
            { width: 4, height: 4, format: "png", hash: "12345678" },
          ],
        ]),
      ),
    );

    const response = await host.fetch(
      new Request("https://example.test/_astro/hero.12345678.png"),
    );
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("page ran");
  });

  test("turns ambiguous exact image output into a 500 response", async () => {
    const metadata = { width: 4, height: 4, format: "png", hash: "12345678" };
    const host = hostOf(
      createMapProjectStore(
        new Map([["src/pages/index.astro", PAGE]]),
        new Map([
          ["a/hero.png", metadata],
          ["b/hero.png", { ...metadata }],
        ]),
      ),
    );

    const response = await host.fetch(
      new Request("https://example.test/_astro/hero.12345678.png"),
    );
    expect(response.status).toBe(500);
    expect(await response.text()).toContain("ProjectAssetOutputAmbiguityError");
  });

  test("fails the page when a referenced generated asset cannot be retained", async () => {
    const host = createProjectHost({
      store: createMapProjectStore(
        new Map([
          [
            "src/pages/index.astro",
            `---\nimport script from "../scripts/large.js?url";\n---\n<script src={script}></script>\n`,
          ],
          ["src/scripts/large.js", "export const payload = 'larger than the cache';\n"],
        ]),
      ),
      loader,
      compiler,
      generatedAssetCache: { maxEntries: 2, maxBytes: 4 },
    });

    await expect(host.render("/")).rejects.toBeInstanceOf(GeneratedAssetRetentionError);
    const response = await host.fetch(new Request("https://example.test/"));
    expect(response.status).toBe(500);
    expect(await response.text()).toContain("GeneratedAssetRetentionError");
  });

  test("inlines only CSS reached from the page import graph", async () => {
    const host = hostOf(
      createMapProjectStore(
        new Map([
          ["src/pages/index.astro", PAGE],
          ["src/styles/site.css", "body { background: papayawhip; }"],
        ]),
      ),
    );

    const html = await (await host.fetch(new Request("https://example.test/"))).text();

    expect(html).toContain("rebeccapurple");
    expect(html).not.toContain("papayawhip");
    expect(html).not.toContain('<link rel="stylesheet"');
  });

  test.skipIf(tailwindDir() === null)(
    "resolves host-embedded Tailwind from a live workspace for paths and rendering",
    async () => {
      const workspace = new FakeWorkspace();
      workspace.write(
        "/src/pages/index.astro",
        `---\nimport "../styles/global.css";\n---\n<html><body><p class="p-special">home</p></body></html>\n`,
      );
      workspace.write(
        "/src/styles/global.css",
        '@import "tailwindcss";\n@import "./tokens.css";\n.entry-sentinel { --entry: 1; }\n',
      );
      workspace.write(
        "/src/styles/tokens.css",
        "@theme { --spacing-special: 3rem; }\n.dep-sentinel { --dep: 1; }\n",
      );
      const host = createProjectHost({
        store: createWorkspaceProjectStore(workspace, { revision: () => workspace.revision }),
        loader,
        compiler,
        tailwind: await tailwindStylesheets(),
      });

      expect((await host.paths()).map((path) => path.pathname)).toEqual(["/"]);
      const response = await host.fetch(new Request("https://example.test/"));
      const html = await response.text();

      expect(response.status, html).toBe(200);
      expect(html).toContain(".p-special");
      expect(html).toContain("--spacing-special");
      expect(html).toContain("--dep: 1");
      expect(html).not.toContain('@import "tailwindcss"');
    },
  );

  test("an unknown pathname is a 404, not a throw", async () => {
    const host = hostOf(createMapProjectStore(new Map([["src/pages/index.astro", PAGE]])));

    const response = await host.fetch(new Request("https://example.test/nope"));

    expect(response.status).toBe(404);
  });

  describe("configured artifacts", () => {
    const artifactPath = ".pletivo/site.json";

    function artifactHost(source?: string) {
      const project = new Map<string, string>([
        ["src/pages/index.md", "---\ntitle: Local\n---\n\nbody\n"],
      ]);
      if (source !== undefined) project.set(artifactPath, source);
      return createProjectHost({
        store: createMapProjectStore(project),
        artifactPath,
        loader,
        compiler,
      });
    }

    test("rejects a missing configured artifact before route handling", async () => {
      await expect(artifactHost().render("/missing")).rejects.toBeInstanceOf(
        ProjectArtifactError,
      );
    });

    test("rejects invalid JSON instead of falling back to local-only source", async () => {
      await expect(artifactHost("{").render("/")).rejects.toBeInstanceOf(ProjectArtifactError);
    });

    test("rejects wrong-version and malformed V2 envelopes", async () => {
      const wrongVersion = JSON.stringify({
        artifact: { version: 1, config: {}, scripts: {}, modules: [], resolutions: [] },
      });
      const malformed = JSON.stringify({ artifact: { version: 2 } });
      await expect(artifactHost(wrongVersion).render("/")).rejects.toBeInstanceOf(
        ProjectArtifactError,
      );
      await expect(artifactHost(malformed).render("/")).rejects.toBeInstanceOf(
        ProjectArtifactError,
      );
    });

    test("parses the artifact before taking the direct markdown path", async () => {
      await expect(artifactHost("null").render("/")).rejects.toBeInstanceOf(ProjectArtifactError);
    });

    function artifactMarking(marker: string, externals: readonly string[] = []): string {
      return JSON.stringify({
        artifact: {
          version: ARTIFACT_VERSION,
          config: {},
          scripts: { headInline: [`window.marker = "${marker}";`], page: [] },
          modules: [],
          resolutions: externals.map((specifier) => ({
            importer: "project:src/pages/index.md",
            specifier,
            target: { kind: "external", specifier },
          })),
        },
      });
    }

    test("loads the artifact again only when its source changes", async () => {
      const files = new Map<string, string>([
        ["src/pages/index.md", "---\ntitle: Local\n---\n\nbody\n"],
        [artifactPath, artifactMarking("first")],
      ]);
      const assets = createProjectAssetsView(new Map());
      const store: ProjectStore = {
        snapshot: () => Promise.resolve({ files: new Map(files), assets, revision: "constant" }),
      };
      const host = createProjectHost({ store, artifactPath, loader, compiler });
      const parse = spyOn(JSON, "parse");
      const parsesOf = (source: string) =>
        parse.mock.calls.filter(([text]) => text === source).length;
      try {
        expect((await host.render("/")).html).toContain(`window.marker = "first";`);
        // An equal source in a new string still reuses the loaded artifact.
        files.set(artifactPath, artifactMarking("first"));
        expect((await host.render("/")).html).toContain(`window.marker = "first";`);
        expect(parsesOf(artifactMarking("first"))).toBe(1);

        files.set(artifactPath, artifactMarking("second"));
        const reloaded = (await host.render("/")).html;
        expect(reloaded).toContain(`window.marker = "second";`);
        expect(reloaded).not.toContain(`window.marker = "first";`);
        expect(parsesOf(artifactMarking("second"))).toBe(1);
      } finally {
        parse.mockRestore();
      }
    });

    test("surfaces an unsupported external as itself, not as a malformed artifact", async () => {
      const source = artifactMarking("unused", ["node:fs"]);

      await expect(artifactHost(source).render("/")).rejects.toBeInstanceOf(
        UnsupportedArtifactExternalError,
      );
      const response = await artifactHost(source).fetch(new Request("https://example.test/"));
      expect(response.status).toBe(500);
      expect(await response.text()).toContain("UnsupportedArtifactExternalError");
    });

    test("rejects a wrong-version direct artifact when the host is created", () => {
      expect(() =>
        createProjectHost({
          store: createMapProjectStore(new Map()),
          artifact: {
            artifact: { version: 1, config: {}, scripts: {}, modules: [], resolutions: [] },
          },
          loader,
          compiler,
        }),
      ).toThrow(ArtifactVersionError);
    });
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

  describe("a lazy workspace", () => {
    const LAYOUT = `<html><body><slot /></body></html>\n`;
    const HOME = `---\nimport Layout from "../components/Layout.astro";\n---\n<Layout><h1>home</h1></Layout>\n`;

    function workspaceWithPage(): FakeWorkspace {
      const workspace = new FakeWorkspace();
      workspace.write("/src/pages/index.astro", HOME);
      workspace.write("/src/components/Layout.astro", LAYOUT);
      return workspace;
    }

    test("a render reads only the files its page reaches", async () => {
      const workspace = workspaceWithPage();
      workspace.write("/src/data/unrelated.json", JSON.stringify("x".repeat(1024 * 1024)));
      workspace.write("/src/assets/photo.png", new Uint8Array(1024 * 1024));
      const host = hostOf(
        createWorkspaceProjectStore(workspace, { revision: () => workspace.revision }),
      );

      const response = await host.fetch(new Request("https://example.test/"));

      expect(response.status).toBe(200);
      expect([...workspace.reads].sort()).toEqual([
        "/src/components/Layout.astro",
        "/src/pages/index.astro",
      ]);
    });

    test("a write during the render is retried on a fresh snapshot", async () => {
      const workspace = workspaceWithPage();
      let writes = 0;
      workspace.onRead = (path) => {
        if (path !== "/src/pages/index.astro" || writes > 0) return;
        writes++;
        workspace.write("/src/components/Layout.astro", `<html><body><slot />v2</body></html>\n`);
      };
      const host = hostOf(
        createWorkspaceProjectStore(workspace, { revision: () => workspace.revision }),
      );

      const response = await host.fetch(new Request("https://example.test/"));

      expect(response.status).toBe(200);
      expect(await response.text()).toContain("v2");
      expect(workspace.reads.filter((path) => path === "/src/pages/index.astro")).toHaveLength(2);
    });

    test("a workspace that keeps moving is a 503, not a mixed render", async () => {
      const workspace = workspaceWithPage();
      workspace.onRead = () => workspace.write("/churn.txt", String(workspace.revision));
      const host = hostOf(
        createWorkspaceProjectStore(workspace, { revision: () => workspace.revision }),
      );

      await expect(host.render("/")).rejects.toBeInstanceOf(WorkspaceSnapshotChangedError);
      const response = await host.fetch(new Request("https://example.test/"));

      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("1");
      expect(await response.text()).toContain("workspace changed");
    });
  });

  describe("content collections over a lazy workspace", () => {
    const CONFIG = `import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

export const collections = {
  notes: defineCollection({
    loader: glob({ base: "src/content/notes", pattern: "**/*.md" }),
    schema: ({ image }) => z.object({ title: z.string(), cover: image().optional() }),
  }),
};
`;
    const INDEX = `---
import { getCollection } from "astro:content";
const notes = await getCollection("notes");
---
<html><body><ul>{notes.map((note) => <li data-w={note.data.cover?.width}>{note.data.title}</li>)}</ul></body></html>
`;
    const GIF = Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="), (char) =>
      char.charCodeAt(0),
    );

    function collectionWorkspace(): FakeWorkspace {
      const workspace = new FakeWorkspace();
      workspace.write("/src/content.config.ts", CONFIG);
      workspace.write("/src/pages/index.astro", INDEX);
      workspace.write("/src/content/notes/a.md", "---\ntitle: Alpha\n---\n\nbody\n");
      workspace.write("/src/content/notes/b.md", "---\ntitle: Beta\n---\n\nbody\n");
      return workspace;
    }

    // One instance for every test: a Loader-cached isolate keeps the binding it started with.
    const content = new ContentFiles();

    function contentHost(workspace: FakeWorkspace, maxFileBytes?: number) {
      return createProjectHost({
        store: createWorkspaceProjectStore(workspace, {
          revision: () => workspace.revision,
          maxFileBytes,
        }),
        loader,
        compiler,
        content: { binding: content, store: content },
        executionNamespace: { tenant: "project-host-tests", capabilityGeneration: "content-v1" },
      });
    }

    /** Write once, right after the first read of `trigger`, so the next read sees a moved workspace. */
    function writeAfterFirstRead(workspace: FakeWorkspace, trigger: string, write: () => void) {
      let written = false;
      workspace.onRead = (path) => {
        if (written || path !== trigger) return;
        written = true;
        write();
      };
    }

    test("a write racing a content read is retried on a fresh snapshot", async () => {
      const workspace = collectionWorkspace();
      writeAfterFirstRead(workspace, "/src/content/notes/a.md", () =>
        workspace.write("/src/content/notes/b.md", "---\ntitle: Beta two\n---\n\nbody\n"),
      );

      const response = await contentHost(workspace).fetch(new Request("https://example.test/"));
      const html = await response.text();

      expect(response.status, html).toBe(200);
      expect(html).toContain("Beta two");
      expect(workspace.reads.filter((path) => path === "/src/content/notes/a.md")).toHaveLength(2);
    });

    test("a write racing an image read through the binding is retried", async () => {
      const workspace = collectionWorkspace();
      workspace.write("/src/content/notes/a.md", "---\ntitle: Alpha\ncover: ./cover.gif\n---\n\nbody\n");
      workspace.write("/src/content/notes/cover.gif", GIF);
      writeAfterFirstRead(workspace, "/src/content/notes/b.md", () =>
        workspace.write("/src/content/notes/b.md", "---\ntitle: Beta two\n---\n\nbody\n"),
      );

      const response = await contentHost(workspace).fetch(new Request("https://example.test/"));
      const html = await response.text();

      expect(response.status, html).toBe(200);
      expect(html).toContain('data-w="1"');
      expect(html).toContain("Beta two");
      expect(workspace.reads.filter((path) => path === "/src/content/notes/cover.gif")).toHaveLength(1);
    });

    test("an oversized entry is left out of the collection, not a broken render", async () => {
      const workspace = collectionWorkspace();
      workspace.write("/src/content/notes/huge.md", `---\ntitle: Huge\n---\n\n${"x".repeat(4096)}\n`);

      const response = await contentHost(workspace, 2048).fetch(new Request("https://example.test/"));
      const html = await response.text();

      expect(response.status, html).toBe(200);
      expect(html).toContain("Alpha");
      expect(html).toContain("Beta");
      expect(html).not.toContain("Huge");
      expect(workspace.reads).not.toContain("/src/content/notes/huge.md");
    });
  });

  describe("a stale workspace artifact", () => {
    const artifactPath = ".pletivo/site.json";
    const PACKAGE = `{"name":"demo","dependencies":{}}`;

    async function preparedWorkspace(): Promise<FakeWorkspace> {
      const workspace = new FakeWorkspace();
      workspace.write("/src/pages/index.md", "---\ntitle: Local\n---\n\nbody\n");
      workspace.write("/package.json", PACKAGE);
      workspace.write(
        `/${artifactPath}`,
        JSON.stringify({
          artifact: {
            version: ARTIFACT_VERSION,
            config: {},
            scripts: { headInline: [], page: [] },
            modules: [],
            resolutions: [],
          },
          inputs: [
            {
              path: "package.json",
              digest: await digestArtifactInput(new TextEncoder().encode(PACKAGE)),
            },
          ],
        }),
      );
      return workspace;
    }

    function artifactHost(workspace: FakeWorkspace) {
      return createProjectHost({
        store: createWorkspaceProjectStore(workspace, { revision: () => workspace.revision }),
        artifactPath,
        loader,
        compiler,
      });
    }

    test("an unchanged input sends no warning", async () => {
      const host = artifactHost(await preparedWorkspace());

      const response = await host.fetch(new Request("https://example.test/"));

      expect(response.status).toBe(200);
      expect(response.headers.has("x-pletivo-artifact-stale")).toBe(false);
      expect((await host.render("/")).staleArtifactInputs).toEqual([]);
    });

    test("a changed input is named on the page, which still renders", async () => {
      const workspace = await preparedWorkspace();
      const host = artifactHost(workspace);
      workspace.write("/package.json", `{"name":"demo","dependencies":{"preact":"^10"}}`);

      const response = await host.fetch(new Request("https://example.test/"));

      expect(response.status).toBe(200);
      expect(response.headers.get("x-pletivo-artifact-stale")).toBe("package.json");
      expect(await response.text()).toContain("body");
      expect((await host.render("/")).staleArtifactInputs).toEqual(["package.json"]);
    });

    test("an input over maxFileBytes is digested from its bytes and not kept", async () => {
      const LOCKFILE = `{"lockfileVersion":1,"packages":{${'"p":{},'.repeat(512)}"q":{}}}`;
      const workspace = new FakeWorkspace();
      workspace.write("/src/pages/index.md", "---\ntitle: Local\n---\n\nbody\n");
      workspace.write("/bun.lock", LOCKFILE);
      workspace.write(
        `/${artifactPath}`,
        JSON.stringify({
          artifact: {
            version: ARTIFACT_VERSION,
            config: {},
            scripts: { headInline: [], page: [] },
            modules: [],
            resolutions: [],
          },
          inputs: [
            {
              path: "bun.lock",
              digest: await digestArtifactInput(new TextEncoder().encode(LOCKFILE)),
            },
          ],
        }),
      );
      const host = createProjectHost({
        store: createWorkspaceProjectStore(workspace, {
          revision: () => workspace.revision,
          maxFileBytes: 1024,
        }),
        artifactPath,
        loader,
        compiler,
      });

      const response = await host.fetch(new Request("https://example.test/"));

      expect(response.status).toBe(200);
      expect(response.headers.has("x-pletivo-artifact-stale")).toBe(false);
      expect(workspace.reads.filter((path) => path === "/bun.lock")).toHaveLength(1);
      const snapshot = await host.snapshot();
      expect(snapshot.files.get("bun.lock")).toBeUndefined();
      expect(workspace.reads.filter((path) => path === "/bun.lock")).toHaveLength(1);
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
