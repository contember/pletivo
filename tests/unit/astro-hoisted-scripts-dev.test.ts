import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "fs/promises";
import path from "path";
import {
  registerAstroPlugin,
  getHoistedScript,
  clearHoistedScripts,
  hoistedScriptId,
} from "../../packages/pletivo/src/astro-plugin";
import { bumpDevVersion } from "../../packages/pletivo/src/dev-cache";

const fixtureRoot = path.join(import.meta.dir, "__hoisted-scripts-dev-fixture__");
const fixtureFile = path.join(fixtureRoot, "page.astro");

async function writeAstroPage(scriptBody: string): Promise<void> {
  await fs.mkdir(fixtureRoot, { recursive: true });
  await fs.writeFile(
    fixtureFile,
    `---\nconst title = "Page";\n---\n<html><head><title>{title}</title></head><body><h1>x</h1></body></html>\n<script>\n${scriptBody}\n</script>\n`,
  );
}

function expectedScriptId(): string {
  return hoistedScriptId(path.relative(process.cwd(), fixtureFile), 0);
}

describe("dev mode: hoisted <script> TS-stripping across re-imports", () => {
  beforeAll(async () => {
    await registerAstroPlugin();
    clearHoistedScripts();
  });

  afterAll(async () => {
    clearHoistedScripts();
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  test("first import strips TS from hoisted script", async () => {
    await writeAstroPage(
      `const value: number = 1;\ndocument.documentElement.dataset.value = String(value);`,
    );
    await import(fixtureFile + `?v=${bumpDevVersion()}`);

    const code = getHoistedScript(expectedScriptId());
    expect(code).toBeDefined();
    expect(code).not.toMatch(/:\s*number/);
    expect(code).toContain("const value");
    expect(code).toContain("dataset.value");
  });

  test("re-import after edit replaces stale entry with new TS-stripped content", async () => {
    await writeAstroPage(
      `const updated: string = "edited";\ndocument.documentElement.dataset.updated = updated;`,
    );
    await import(fixtureFile + `?v=${bumpDevVersion()}`);

    const code = getHoistedScript(expectedScriptId());
    expect(code).toBeDefined();
    expect(code).not.toMatch(/:\s*string/);
    expect(code).toContain("edited");
    expect(code).not.toContain("const value");
    expect(code).not.toContain("dataset.value");
  });

  test("removing the <script> block clears the entry on re-import", async () => {
    await fs.writeFile(
      fixtureFile,
      `---\nconst title = "Page";\n---\n<html><head><title>{title}</title></head><body><h1>x</h1></body></html>\n`,
    );
    await import(fixtureFile + `?v=${bumpDevVersion()}`);

    expect(getHoistedScript(expectedScriptId())).toBeUndefined();
  });
});
