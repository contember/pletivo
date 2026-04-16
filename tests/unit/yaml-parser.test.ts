import { describe, test, expect, beforeAll } from "bun:test";
import path from "path";
import fs from "fs/promises";
import { initCollections, getCollection, defineCollection, glob } from "../../packages/pletivo/src/content/collection";
import { z } from "zod";

const fixtureRoot = path.join(import.meta.dir, "../fixture-yaml");
const contentDir = path.join(fixtureRoot, "src/content/data");
const configPath = path.join(fixtureRoot, "src/content.config.ts");

describe("YAML parser (js-yaml)", () => {
  beforeAll(async () => {
    await fs.mkdir(contentDir, { recursive: true });

    // Test file with advanced YAML features
    await fs.writeFile(
      path.join(contentDir, "anchors.yaml"),
      `title: Anchors Test
defaults: &defaults
  adapter: postgres
  host: localhost
development:
  database: myapp_dev
  <<: *defaults
production:
  database: myapp_prod
  <<: *defaults
`,
    );

    await fs.writeFile(
      path.join(contentDir, "multiline.yaml"),
      `title: Multiline Test
description: >
  This is a long
  description that
  should be folded.
literal: |
  Line one
  Line two
  Line three
`,
    );

    await fs.writeFile(
      path.join(contentDir, "flow.yaml"),
      `title: Flow Test
tags: [alpha, beta, gamma]
config: {debug: true, level: 5}
`,
    );

    // Write config
    (globalThis as any).__yamlTestCollections = {
      data: defineCollection({
        loader: glob({ base: "src/content/data", pattern: "**/*.yaml" }),
        schema: z.object({ title: z.string() }).passthrough(),
      }),
    };
    await fs.writeFile(configPath, `export const collections = (globalThis).__yamlTestCollections;\n`);
    await initCollections(fixtureRoot);
  });

  test("YAML anchors and aliases work", async () => {
    const entries = await getCollection("data");
    const entry = entries.find((e) => e.id === "anchors");
    expect(entry).toBeDefined();
    const data = entry!.data as Record<string, unknown>;
    expect(data.title).toBe("Anchors Test");
    // Anchors should be resolved
    const dev = data.development as Record<string, unknown>;
    expect(dev.database).toBe("myapp_dev");
    expect(dev.adapter).toBe("postgres");
    expect(dev.host).toBe("localhost");
    const prod = data.production as Record<string, unknown>;
    expect(prod.database).toBe("myapp_prod");
    expect(prod.adapter).toBe("postgres");
  });

  test("multiline strings work (folded and literal)", async () => {
    const entries = await getCollection("data");
    const entry = entries.find((e) => e.id === "multiline");
    expect(entry).toBeDefined();
    const data = entry!.data as Record<string, unknown>;
    expect(data.title).toBe("Multiline Test");
    // Folded (>) joins lines with spaces
    expect((data.description as string).trim()).toBe(
      "This is a long description that should be folded.",
    );
    // Literal (|) preserves newlines
    expect((data.literal as string).trim()).toBe("Line one\nLine two\nLine three");
  });

  test("flow mappings and sequences work", async () => {
    const entries = await getCollection("data");
    const entry = entries.find((e) => e.id === "flow");
    expect(entry).toBeDefined();
    const data = entry!.data as Record<string, unknown>;
    expect(data.title).toBe("Flow Test");
    expect(data.tags).toEqual(["alpha", "beta", "gamma"]);
    const config = data.config as Record<string, unknown>;
    expect(config.debug).toBe(true);
    expect(config.level).toBe(5);
  });
});
