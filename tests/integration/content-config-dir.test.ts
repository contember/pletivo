import { describe, test, expect, beforeAll } from "bun:test";
import path from "path";
import { initCollections, getCollection } from "../../packages/pletivo/src/content/collection";

const fixtureRoot = path.join(import.meta.dir, "../fixture-content-config-dir");

describe("content config discovery", () => {
  beforeAll(async () => {
    await initCollections(fixtureRoot);
  });

  test("loads Astro's src/content/config.ts layout", async () => {
    const entries = await getCollection("configured");
    expect(entries).toHaveLength(1);
    expect(entries[0].data.title).toBe("Directory content config");
  });
});
