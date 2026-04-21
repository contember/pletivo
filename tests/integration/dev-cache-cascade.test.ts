import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "fs/promises";
import path from "path";
import { bumpDevVersion } from "../../packages/pletivo/src/dev-cache";
import { registerDevTsPlugin } from "../../packages/pletivo/src/dev-ts-plugin";

const fixtureRoot = path.join(
  import.meta.dir,
  "__dev-cache-cascade-fixture__",
);

async function writeFixture(helloValue: string): Promise<void> {
  await fs.mkdir(path.join(fixtureRoot, "i18n"), { recursive: true });
  await fs.writeFile(
    path.join(fixtureRoot, "i18n", "data.json"),
    JSON.stringify({ hello: helloValue }),
  );
  await fs.writeFile(
    path.join(fixtureRoot, "i18n", "index.ts"),
    [
      `import data from './data.json'`,
      `export const t = (key: keyof typeof data): string => data[key]`,
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    path.join(fixtureRoot, "entry.ts"),
    [
      `import { t } from './i18n'`,
      `export default () => t('hello')`,
      "",
    ].join("\n"),
  );
}

async function loadEntry(version: number): Promise<() => string> {
  const mod = (await import(
    path.join(fixtureRoot, "entry.ts") + `?v=${version}`
  )) as { default: () => string };
  return mod.default;
}

describe("dev cache-bust cascade", () => {
  beforeAll(async () => {
    await registerDevTsPlugin(fixtureRoot, "");
    await writeFixture("v1");
  });

  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  test("initial render picks up the first JSON value", async () => {
    const v1 = bumpDevVersion();
    const render = await loadEntry(v1);
    expect(render()).toBe("v1");
  });

  test("after editing the JSON and bumping the version, the next render sees the new value", async () => {
    await fs.writeFile(
      path.join(fixtureRoot, "i18n", "data.json"),
      JSON.stringify({ hello: "v2" }),
    );

    const v2 = bumpDevVersion();
    const render = await loadEntry(v2);
    expect(render()).toBe("v2");
  });

  test("editing the TS intermediary also propagates on the next render", async () => {
    await fs.writeFile(
      path.join(fixtureRoot, "i18n", "index.ts"),
      [
        `export const t = (_key: string): string => 'from-ts'`,
        "",
      ].join("\n"),
    );

    const v3 = bumpDevVersion();
    const render = await loadEntry(v3);
    expect(render()).toBe("from-ts");
  });
});
