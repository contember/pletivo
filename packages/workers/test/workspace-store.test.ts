import { describe, expect, test } from "bun:test";
import {
  createWorkspaceProjectStore,
  WorkspaceSnapshotChangedError,
  type WorkspaceDirent,
  type WorkspaceFiles,
} from "../src/workspace-store.ts";

class FakeWorkspace implements WorkspaceFiles {
  readonly reads: string[] = [];
  onRead: ((path: string) => void) | undefined;
  readonly #text = new Map<string, string>();
  readonly #bytes = new Map<string, Uint8Array>();
  #revision = 0;

  get revision(): number {
    return this.#revision;
  }

  write(path: string, value: string | Uint8Array): void {
    if (typeof value === "string") {
      this.#text.set(path, value);
      this.#bytes.delete(path);
    } else {
      this.#bytes.set(path, value);
      this.#text.delete(path);
    }
    this.#revision++;
  }

  readdirSync(path: string, options?: { withFileTypes?: boolean }): string[] | WorkspaceDirent[] {
    if (options?.withFileTypes !== true) throw new Error("withFileTypes is required");
    const prefix = path === "/" ? "/" : `${path}/`;
    const names = new Map<string, boolean>();
    for (const file of [...this.#text.keys(), ...this.#bytes.keys()]) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      const slash = rest.indexOf("/");
      names.set(slash === -1 ? rest : rest.slice(0, slash), slash !== -1);
    }
    return [...names].map(([name, directory]) => ({
      name,
      isFile: () => !directory,
      isDirectory: () => directory,
    }));
  }

  readFileSync(path: string, options?: { encoding?: string | null } | string | null): unknown {
    this.reads.push(path);
    this.onRead?.(path);
    const text = this.#text.get(path);
    if (text !== undefined) return options ? text : new TextEncoder().encode(text);
    const bytes = this.#bytes.get(path);
    if (bytes !== undefined) return options ? new TextDecoder().decode(bytes) : bytes;
    throw new Error(`No file ${path}`);
  }

  statSync(path: string): { size: number } {
    const text = this.#text.get(path);
    if (text !== undefined) return { size: new TextEncoder().encode(text).byteLength };
    const bytes = this.#bytes.get(path);
    if (bytes !== undefined) return { size: bytes.byteLength };
    throw new Error(`No file ${path}`);
  }

  existsSync(path: string): boolean {
    return this.#text.has(path) || this.#bytes.has(path);
  }
}

function gif(width: number, height: number, tail: number): Uint8Array {
  return Uint8Array.of(
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61,
    width & 0xff, width >> 8,
    height & 0xff, height >> 8,
    tail,
  );
}

describe("createWorkspaceProjectStore", () => {
  test("keeps a revision's files and asset bytes in one immutable snapshot", async () => {
    const workspace = new FakeWorkspace();
    workspace.write("/src/pages/index.astro", "<p>old</p>");
    workspace.write("/src/assets/hero.gif", gif(1, 1, 1));
    const store = createWorkspaceProjectStore(workspace, {
      revision: () => workspace.revision,
    });

    const before = await store.snapshot();
    const oldInfo = await before.assets.info("src/assets/hero.gif");
    workspace.write("/src/pages/index.astro", "<p>new</p>");
    workspace.write("/src/assets/hero.gif", gif(2, 3, 2));
    const after = await store.snapshot();

    expect(before.files.get("src/pages/index.astro")).toBe("<p>old</p>");
    expect(oldInfo?.width).toBe(1);
    expect((await before.assets.info("src/assets/hero.gif"))?.width).toBe(1);
    expect(after.files.get("src/pages/index.astro")).toBe("<p>new</p>");
    expect((await after.assets.info("src/assets/hero.gif"))?.width).toBe(2);
  });

  test("reuses the whole snapshot while the revision is unchanged", async () => {
    const workspace = new FakeWorkspace();
    workspace.write("/src/pages/index.astro", "<p>page</p>");
    workspace.write("/src/assets/hero.gif", gif(1, 1, 1));
    const store = createWorkspaceProjectStore(workspace, {
      revision: () => workspace.revision,
    });

    const first = await store.snapshot();
    const reads = workspace.reads.length;
    const second = await store.snapshot();

    expect(second).toBe(first);
    expect(second.assets).toBe(first.assets);
    expect(workspace.reads.length).toBe(reads);
  });

  test("retries once when the workspace changes during a walk", async () => {
    const workspace = new FakeWorkspace();
    workspace.write("/src/pages/index.astro", "<p>old</p>");
    workspace.write("/src/assets/hero.gif", gif(1, 1, 1));
    let changed = false;
    workspace.onRead = () => {
      if (changed) return;
      changed = true;
      workspace.write("/src/pages/index.astro", "<p>new</p>");
      workspace.write("/src/assets/hero.gif", gif(2, 3, 2));
    };
    const store = createWorkspaceProjectStore(workspace, {
      revision: () => workspace.revision,
    });

    const snapshot = await store.snapshot();

    expect(snapshot.revision).toBe(String(workspace.revision));
    expect(snapshot.files.get("src/pages/index.astro")).toBe("<p>new</p>");
    expect((await snapshot.assets.info("src/assets/hero.gif"))?.width).toBe(2);
    expect(workspace.reads.filter((path) => path === "/src/pages/index.astro")).toHaveLength(2);
    expect(workspace.reads.filter((path) => path === "/src/assets/hero.gif")).toHaveLength(2);
  });

  test("fails when the workspace changes during the retry", async () => {
    const workspace = new FakeWorkspace();
    workspace.write("/src/pages/index.astro", "<p>page</p>");
    workspace.onRead = () => {
      workspace.write("/churn.txt", String(workspace.revision));
    };
    const store = createWorkspaceProjectStore(workspace, {
      revision: () => workspace.revision,
    });

    await expect(store.snapshot()).rejects.toBeInstanceOf(WorkspaceSnapshotChangedError);
  });

  test("does not reuse an unverified snapshot", async () => {
    const workspace = new FakeWorkspace();
    workspace.write("/src/pages/index.astro", "<p>page</p>");
    const store = createWorkspaceProjectStore(workspace, {
      revision: () => undefined,
    });

    const first = await store.snapshot();
    const reads = workspace.reads.length;
    const second = await store.snapshot();

    expect(first.revision).not.toBe(second.revision);
    expect(second).not.toBe(first);
    expect(workspace.reads.length).toBeGreaterThan(reads);
  });

  test("builds an output index without probing unrelated binary bytes", async () => {
    const workspace = new FakeWorkspace();
    workspace.write("/src/pages/index.astro", "<p>page</p>");
    workspace.write("/src/assets/not-an-image.png", Uint8Array.of(1, 2, 3));
    const store = createWorkspaceProjectStore(workspace, {
      revision: () => workspace.revision,
    });

    const snapshot = await store.snapshot();
    expect(await snapshot.assets.resolveOutput("/docs/page/")).toBeNull();
    expect(snapshot.files.get("src/pages/index.astro")).toBe("<p>page</p>");
  });

  test("does not read a file above maxFileBytes", async () => {
    const workspace = new FakeWorkspace();
    workspace.write("/src/pages/index.astro", "<p>page</p>");
    workspace.write("/large.png", Uint8Array.from({ length: 20 }, () => 1));
    const store = createWorkspaceProjectStore(workspace, {
      revision: () => workspace.revision,
      maxFileBytes: 10,
    });

    const snapshot = await store.snapshot();
    expect(await snapshot.assets.info("large.png")).toBeNull();
    expect(workspace.reads).not.toContain("/large.png");
  });
});
