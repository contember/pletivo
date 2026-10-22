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

async function workspaceRootOf(tree: Tree, site: string, ancestors: string[]): Promise<string | null> {
  return findWorkspaceRoot(readerAt(tree, site), ancestors, (directory) => readerAt(tree, directory));
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
    ]);
  });
});

describe("findWorkspaceRoot", () => {
  test("is null for a site with its own lockfile", async () => {
    const tree: Tree = { "bun.lock": "root", "site/package-lock.json": "site" };
    expect(await workspaceRootOf(tree, "site", [""])).toBeNull();
  });

  test("is null for a site that declares workspaces itself", async () => {
    const tree: Tree = { "bun.lock": "root", "site/package.json": '{"workspaces":[]}' };
    expect(await workspaceRootOf(tree, "site", [""])).toBeNull();
  });

  test("is the nearest ancestor with a lockfile, a binary one included", async () => {
    const tree: Tree = { "bun.lock": "outer", "apps/bun.lockb": "inner", "apps/site/package.json": "{}" };
    expect(await workspaceRootOf(tree, "apps/site", ["apps", ""])).toBe("apps");
  });

  test("is the nearest ancestor whose manifest declares workspaces", async () => {
    const tree: Tree = {
      "package.json": '{"workspaces":{"packages":["packages/*"]}}',
      "packages/package.json": '{"name":"not-a-workspace"}',
      "packages/site/package.json": "{}",
    };
    expect(await workspaceRootOf(tree, "packages/site", ["packages", ""])).toBe("");
  });

  test("skips an ancestor whose manifest is not JSON", async () => {
    const tree: Tree = { "package.json": '{"workspaces":["*"]}', "apps/package.json": "{", "apps/site/a": "" };
    expect(await workspaceRootOf(tree, "apps/site", ["apps", ""])).toBe("");
  });

  test("looks no further than the ancestors it is given", async () => {
    const tree: Tree = { "bun.lock": "outside", "repository/site/package.json": "{}" };
    expect(await workspaceRootOf(tree, "repository/site", ["repository"])).toBeNull();
  });
});
