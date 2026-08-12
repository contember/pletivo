import { describe, expect, test } from "bun:test";
import {
  createContentRuntime,
  defineCollection,
  getCollection,
  getContentBaseDirs,
  getValidationFailures,
  glob,
  initCollections,
  runWithContentRuntime,
  type CollectionConfig,
  type ContentHost,
  type ContentScan,
} from "@pletivo/core/content/collection";
import { z } from "zod";

function deferred(): { promise: Promise<void>; resolve(): void } {
  let settle: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return {
    promise,
    resolve() {
      if (!settle) throw new Error("Deferred promise was not initialized.");
      settle();
    },
  };
}

function deferredValue<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let settle: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return {
    promise,
    resolve(value) {
      if (!settle) throw new Error("Deferred promise was not initialized.");
      settle(value);
    },
  };
}

function collectionConfig(title: string): Record<string, CollectionConfig> {
  return {
    items: defineCollection({
      loader: async () => [{ id: "entry", title }],
      schema: z.object({ title: z.string() }),
    }),
  };
}

interface HostFixture {
  host: ContentHost;
  scans: string[];
  versions: number[];
  deps: string[];
}

function contentHost(
  label: string,
  pause?: { entered: { resolve(): void }; release: Promise<void> },
): HostFixture {
  const scans: string[] = [];
  const versions: number[] = [];
  const deps: string[] = [];
  const host: ContentHost = {
    async scan(projectRoot, base): Promise<ContentScan> {
      scans.push(`${projectRoot}:${base}`);
      pause?.entered.resolve();
      if (pause) await pause.release;
      const root = `${label}:${projectRoot}:${base}`;
      return {
        root,
        rootUrl: new URL(`file:///${root}/`),
        files: [{ entry: "entry.md", path: `${root}/entry.md` }],
      };
    },
    async readFile() {
      return `---\ntitle: ${label}\n---\nBody`;
    },
    dirname(file) {
      return file.slice(0, file.lastIndexOf("/"));
    },
    resolveDir(projectRoot, base) {
      return `${label}:${projectRoot}:${base}`;
    },
    async loadConfig(_projectRoot, version) {
      versions.push(version);
      return {
        items: defineCollection({
          loader: glob({ base: "content" }),
          schema: z.object({ title: z.string() }),
        }),
      };
    },
    recordDep(path) {
      deps.push(path);
    },
  };
  return { host, scans, versions, deps };
}

describe("ContentRuntime", () => {
  test("fails clearly outside an active scope", async () => {
    await expect(getCollection("items")).rejects.toThrow("no active runtime");
    expect(() => getValidationFailures()).toThrow("no active runtime");
  });

  test("keeps overlapping hosts, configs, caches, inflight loads, and deps apart", async () => {
    const leftEntered = deferred();
    const releaseLeft = deferred();
    const leftHost = contentHost("left", {
      entered: leftEntered,
      release: releaseLeft.promise,
    });
    const rightHost = contentHost("right");
    const left = createContentRuntime(leftHost.host);
    const right = createContentRuntime(rightHost.host);

    await runWithContentRuntime(left, () => initCollections("left-root"));
    await runWithContentRuntime(right, () => initCollections("right-root"));

    const leftLoad = runWithContentRuntime(left, () => getCollection("items"));
    await leftEntered.promise;
    const rightEntries = await runWithContentRuntime(right, () => getCollection("items"));
    releaseLeft.resolve();
    const leftEntries = await leftLoad;

    expect(leftEntries[0].data.title).toBe("left");
    expect(rightEntries[0].data.title).toBe("right");
    expect(runWithContentRuntime(left, () => getContentBaseDirs("left-root"))).toEqual([
      "left:left-root:content",
    ]);
    expect(runWithContentRuntime(right, () => getContentBaseDirs("right-root"))).toEqual([
      "right:right-root:content",
    ]);

    await runWithContentRuntime(left, () => getCollection("items"));
    await runWithContentRuntime(right, () => getCollection("items"));
    expect(leftHost.scans).toEqual(["left-root:content"]);
    expect(rightHost.scans).toEqual(["right-root:content"]);
    expect(leftHost.versions).toEqual([1]);
    expect(rightHost.versions).toEqual([1]);
    expect(new Set(leftHost.deps)).toEqual(
      new Set(["left:left-root:content", "left:left-root:content/entry.md"]),
    );
    expect(new Set(rightHost.deps)).toEqual(
      new Set(["right:right-root:content", "right:right-root:content/entry.md"]),
    );
  });

  test("does not publish an older config initialization that completes last", async () => {
    const firstConfig = deferredValue<Record<string, CollectionConfig>>();
    const secondConfig = deferredValue<Record<string, CollectionConfig>>();
    const fixture = contentHost("config-race");
    fixture.host.loadConfig = async (_projectRoot, version) => {
      fixture.versions.push(version);
      return version === 1 ? firstConfig.promise : secondConfig.promise;
    };
    const runtime = createContentRuntime(fixture.host);

    const firstInit = runWithContentRuntime(runtime, () => initCollections("old-root"));
    const secondInit = runWithContentRuntime(runtime, () => initCollections("new-root"));
    expect(fixture.versions).toEqual([1, 2]);

    secondConfig.resolve(collectionConfig("new"));
    await secondInit;
    firstConfig.resolve(collectionConfig("old"));
    await firstInit;

    const entries = await runWithContentRuntime(runtime, () =>
      getCollection<{ title: string }>("items"),
    );
    expect(entries.map((entry) => entry.data.title)).toEqual(["new"]);
  });

  test("keeps a paused stale load out of the reset generation", async () => {
    const staleEntered = deferred();
    const releaseStale = deferred();
    const scans: string[] = [];
    const deps: string[] = [];
    const host: ContentHost = {
      async scan(projectRoot, base) {
        scans.push(`${projectRoot}:${base}`);
        if (projectRoot === "old-root") {
          staleEntered.resolve();
          await releaseStale.promise;
        }
        const root = `${projectRoot}:${base}`;
        return {
          root,
          rootUrl: new URL(`file:///${root}/`),
          files: [{ entry: "entry.md", path: `${root}/entry.md` }],
        };
      },
      async readFile(path) {
        return path.startsWith("old-root:")
          ? "---\nwrong: stale\n---\nOld"
          : "---\ntitle: new\n---\nNew";
      },
      dirname(file) {
        return file.slice(0, file.lastIndexOf("/"));
      },
      resolveDir(projectRoot, base) {
        return `${projectRoot}:${base}`;
      },
      async loadConfig() {
        return {
          items: defineCollection({
            loader: glob({ base: "content" }),
            schema: z.object({ title: z.string() }),
          }),
        };
      },
      recordDep(path) {
        deps.push(path);
      },
    };
    const runtime = createContentRuntime(host);

    await runWithContentRuntime(runtime, () => initCollections("old-root"));
    const staleLoad = runWithContentRuntime(runtime, () => getCollection("items"));
    await staleEntered.promise;
    await runWithContentRuntime(runtime, () => initCollections("new-root"));
    releaseStale.resolve();
    expect(await staleLoad).toEqual([]);
    expect(runWithContentRuntime(runtime, () => getValidationFailures())).toEqual([]);

    deps.length = 0;
    const current = await runWithContentRuntime(runtime, () =>
      getCollection<{ title: string }>("items"),
    );
    await runWithContentRuntime(runtime, () => getCollection("items"));
    expect(current.map((entry) => entry.data.title)).toEqual(["new"]);
    expect(scans).toEqual(["old-root:content", "new-root:content"]);
    expect(new Set(deps)).toEqual(
      new Set(["new-root:content", "new-root:content/entry.md"]),
    );
  });

  test("keeps validation failures scoped to their runtime", async () => {
    const invalidHost = contentHost("invalid");
    invalidHost.host.readFile = async () => "---\nwrong: value\n---\nBody";
    const validHost = contentHost("valid");
    const invalid = createContentRuntime(invalidHost.host);
    const valid = createContentRuntime(validHost.host);

    await runWithContentRuntime(invalid, () => initCollections("project"));
    await runWithContentRuntime(valid, () => initCollections("project"));
    await runWithContentRuntime(invalid, () => getCollection("items"));
    await runWithContentRuntime(valid, () => getCollection("items"));

    expect(runWithContentRuntime(invalid, () => getValidationFailures())).toHaveLength(1);
    expect(runWithContentRuntime(valid, () => getValidationFailures())).toHaveLength(0);
  });
});
