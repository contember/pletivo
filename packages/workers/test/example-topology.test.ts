import { describe, expect, test } from "bun:test";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

const WORKERS_DIR = path.resolve(import.meta.dir, "..");
const REPO_DIR = path.resolve(WORKERS_DIR, "../..");

const PREVIEW_ENTRY = path.join(WORKERS_DIR, "example/src/index.ts");
const PLAYGROUND_ENTRY = path.join(WORKERS_DIR, "example-playground/src/index.ts");
const EXAMPLE_CONFIGS = [
  path.join(WORKERS_DIR, "example/wrangler.jsonc"),
  path.join(WORKERS_DIR, "example-playground/wrangler.jsonc"),
];
const EXAMPLE_SOURCES = [
  PREVIEW_ENTRY,
  path.join(WORKERS_DIR, "example/src/tailwind.ts"),
  PLAYGROUND_ENTRY,
  path.join(WORKERS_DIR, "example-playground/src/tailwind.ts"),
];
const ARCHITECTURE_DOCS = [
  path.join(REPO_DIR, "docs/todos/020-workers-integration-phase.md"),
  path.join(REPO_DIR, "docs/todos/021-cms-source-mapping.md"),
  path.join(REPO_DIR, "docs/todos/023-live-workspace-architecture.md"),
  path.join(WORKERS_DIR, "example-playground/README.md"),
  path.join(WORKERS_DIR, "test/project-host.test.ts"),
];
const DELETED_WORKSPACE_FILES = [
  path.join(WORKERS_DIR, "example-workspace/.gitignore"),
  path.join(WORKERS_DIR, "example-workspace/src/globals.d.ts"),
  path.join(WORKERS_DIR, "example-workspace/src/index.ts"),
  path.join(WORKERS_DIR, "example-workspace/wrangler.jsonc"),
];

async function readAll(files: readonly string[]): Promise<string> {
  return (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

describe("Workers example topology", () => {
  test("keeps one production workspace example with forwarded DO-owned content", async () => {
    const durableConfigs: string[] = [];
    for (const config of EXAMPLE_CONFIGS) {
      if ((await readFile(config, "utf8")).includes('"durable_objects"')) {
        durableConfigs.push(path.relative(WORKERS_DIR, config));
      }
    }
    expect(durableConfigs).toEqual(["example-playground/wrangler.jsonc"]);

    const source = await readFile(PLAYGROUND_ENTRY, "utf8");
    expect(source).toContain("readonly #content = new ContentFiles()");
    expect(source).toContain(
      "binding: ctx.exports.ProjectBinding({ props: { projectId: ctx.id.toString() } })",
    );
    expect(source).toContain("return this.#content.scan(ref, dir, pattern)");
    expect(source).toContain("return this.#content.read(ref, path)");
    expect(source).toContain("return await this.#content.image(ref, path)");
    expect(source).toContain("extends WorkerEntrypoint<Env, { projectId: string }>");
    expect(source).toContain("#target(): DurableObjectStub<ProjectDO>");
    expect(source).toContain("this.env.PROJECT.idFromString(this.ctx.props.projectId)");
    expect(source).not.toContain("env.PROJECT.get(ctx.id)");
    expect(source).toContain("tenant: `project:${ctx.id.toString()}`");
    expect(source).toContain("capabilityGeneration: CONTENT_CAPABILITY_GENERATION");
    expect(source).toContain("compatibilityDate: COMPATIBILITY_DATE");
    expect(source).toContain("compatibilityFlags: COMPATIBILITY_FLAGS");
  });

  test("keeps the request preview stateless and rejects retained assets", async () => {
    const source = await readFile(PREVIEW_ENTRY, "utf8");
    expect(source).toContain("createMapProjectStore(parsed.files)");
    expect(source).toContain("compileCache: false");
    expect(source).toContain("generatedAssetCache: { maxEntries: 0, maxBytes: 0 }");
    expect(source).toContain('Reflect.has(body, "assets")');
    expect(source).toContain("does not accept assets");
    expect(source).not.toContain("rejectContentCollections");
    expect(source).toContain("error instanceof ContentUnavailableError");
    expect(source).toContain("This stateless preview has no content binding");
    expect(source).not.toContain("PletivoContent");
    expect(source).not.toContain("new ContentFiles");
    expect(source).toContain("tenant: requireIdentity(body.tenant");
    expect(source).toContain("capabilityGeneration: requireIdentity(");
    expect(source).toContain("executionNamespace:");
  });

  test("uses public package seams and leaves no tracked duplicate reference", async () => {
    const examples = await readAll(EXAMPLE_SOURCES);
    expect(examples).not.toMatch(/from\s+["'][.]{2}\/[.]{2}\/src\//);
    expect(examples).not.toContain('from "@pletivo/core/');
    expect(examples).not.toContain("example-workspace");
    expect(examples).not.toContain("GeneratedAssetCache");
    expect(examples).not.toContain("RenderedAsset");
    expect(examples).not.toContain("ASSET_LIMIT");

    for (const file of DELETED_WORKSPACE_FILES) {
      expect(await fileExists(file), file).toBe(false);
    }

    const docs = await readAll(ARCHITECTURE_DOCS);
    expect(docs).not.toContain("example-workspace");
  });
});
