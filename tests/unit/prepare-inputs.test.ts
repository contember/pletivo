import { describe, expect, test } from "bun:test";
import { digestArtifactInput } from "@pletivo/core/artifact";
import {
  findWorkspaceRoot,
  readPrepareInputs,
  type InputFileReader,
} from "@pletivo/core/prepare-inputs";

/** A directory tree as `/`-separated paths, `""` being its root. */
type Tree = Record<string, string>;

function readerAt(tree: Tree, directory: string): InputFileReader {
  return async (file) => {
    const source = tree[directory === "" ? file : `${directory}/${file}`];
    return source === undefined ? null : new TextEncoder().encode(source);
  };
}

async function input(path: string, source: string): Promise<{ path: string; digest: string }> {
  return { path, digest: await digestArtifactInput(new TextEncoder().encode(source)) };
}

async function workspaceRootOf(tree: Tree, site: string): Promise<string | null> {
  return findWorkspaceRoot(site, (directory) => readerAt(tree, directory));
}

describe("readPrepareInputs", () => {
  test("records the package files and the first config of each kind, sorted, without bun.lockb", async () => {
    const tree: Tree = {
      "package.json": "{}",
      "bun.lock": "lock",
      "bun.lockb": "binary",
      "yarn.lock": "yarn",
      "astro.config.mjs": "mjs",
      "astro.config.js": "js",
      "pletivo.config.js": "pletivo",
    };

    expect(await readPrepareInputs(readerAt(tree, ""))).toEqual([
      await input("astro.config.mjs", "mjs"),
      await input("bun.lock", "lock"),
      await input("package.json", "{}"),
      await input("pletivo.config.js", "pletivo"),
      await input("yarn.lock", "yarn"),
    ]);
  });

  test("records the workspace root's package files under the workspace prefix", async () => {
    const tree: Tree = {
      "package.json": '{"workspaces":["sites/*"]}',
      "bun.lock": "root lock",
      "pnpm-workspace.yaml": "packages: []",
      "astro.config.mjs": "not the site's",
      "sites/blog/package.json": "{}",
    };

    const inputs = await readPrepareInputs(readerAt(tree, "sites/blog"), {
      workspaceRoot: readerAt(tree, ""),
    });

    expect(inputs).toEqual([
      await input("package.json", "{}"),
      await input("workspace:bun.lock", "root lock"),
      await input("workspace:package.json", '{"workspaces":["sites/*"]}'),
      await input("workspace:pnpm-workspace.yaml", "packages: []"),
    ]);
  });
});

describe("findWorkspaceRoot", () => {
  const ROOT = '{"workspaces":["packages/*"]}';

  test("is the nearest directory whose workspaces list the site", async () => {
    const tree: Tree = { "package.json": ROOT, "packages/site/package.json": "{}" };
    expect(await workspaceRootOf(tree, "packages/site")).toBe("");
  });

  test("reads the object form, pnpm-workspace.yaml, globstars, alternations and ./ prefixes", async () => {
    const cases: Array<[Tree, string]> = [
      [{ "package.json": '{"workspaces":{"packages":["apps/*"]}}' }, "apps/site"],
      [{ "pnpm-workspace.yaml": "packages:\n  - 'apps/**'\n" }, "apps/web/site"],
      [{ "package.json": '{"workspaces":["{apps,sites}/*"]}' }, "sites/blog"],
      [{ "package.json": '{"workspaces":["./site/"]}' }, "site"],
    ];
    for (const [tree, site] of cases) {
      expect(await workspaceRootOf({ ...tree, [`${site}/package.json`]: "{}" }, site)).toBe("");
    }
  });

  test("skips a directory whose workspaces do not list the site, or exclude it", async () => {
    const tree: Tree = {
      "package.json": '{"workspaces":["apps/**","!apps/legacy"]}',
      "apps/package.json": ROOT,
      "apps/legacy/package.json": "{}",
      "apps/site/package.json": "{}",
    };
    expect(await workspaceRootOf(tree, "apps/site")).toBe("");
    expect(await workspaceRootOf(tree, "apps/legacy")).toBeNull();
  });

  test("ignores a lockfile without workspaces, null workspaces and broken manifests", async () => {
    const site = { "a/b/site/package.json": "{}" };
    expect(await workspaceRootOf({ ...site, "bun.lock": "lock" }, "a/b/site")).toBeNull();
    expect(await workspaceRootOf({ ...site, "package.json": '{"workspaces":null}' }, "a/b/site")).toBeNull();
    expect(
      await workspaceRootOf({ ...site, "package.json": '{"workspaces":["**"]}', "a/package.json": "{" }, "a/b/site"),
    ).toBe("");
  });

  test("is null for a site without a manifest, with its own lockfile or with workspaces of its own", async () => {
    const root = { "package.json": '{"workspaces":["site"]}' };
    expect(await workspaceRootOf({ ...root, "site/index.html": "" }, "site")).toBeNull();
    expect(await workspaceRootOf({ ...root, "site/package.json": "{}", "site/bun.lockb": "" }, "site")).toBeNull();
    expect(await workspaceRootOf({ ...root, "site/package.json": '{"workspaces":[]}' }, "site")).toBeNull();
  });

  test("is null for the top of the search itself", async () => {
    expect(await workspaceRootOf({ "package.json": "{}" }, "")).toBeNull();
  });
});
