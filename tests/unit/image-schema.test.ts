import { describe, test, expect, beforeEach } from "bun:test";
import path from "path";
import fs from "fs/promises";
import {
  defineCollection,
  initCollections,
  getCollection,
  glob,
  getValidationFailures,
} from "../../packages/pletivo/src/content/collection";
import { z } from "zod";
import { setImageMode } from "../../packages/pletivo/src/image";

const fixtureRoot = path.join(import.meta.dir, "../fixture-image-collection");
const configPath = path.join(fixtureRoot, "src/content.config.ts");

async function writeConfig(collections: Record<string, ReturnType<typeof defineCollection>>) {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  (globalThis as Record<string, unknown>).__testCollections = collections;
  await fs.writeFile(
    configPath,
    `export const collections = globalThis.__testCollections;\n`,
  );
}

describe("image() schema", () => {
  beforeEach(async () => {
    await writeConfig({
      items: defineCollection({
        loader: glob({ base: "src/content/items" }),
        schema: ({ image }) =>
          z.object({
            name: z.string(),
            logo: image(),
            url: z.string(),
          }),
      }),
    });
    await initCollections(fixtureRoot);
  });

  test("resolves a relative frontmatter path to ImageMetadata in dev", async () => {
    setImageMode("dev", "/");
    const entries = await getCollection("items");
    expect(entries.length).toBe(1);
    const logo = entries[0].data.logo as {
      src: string;
      width: number;
      height: number;
      format: string;
    };
    expect(logo.width).toBe(4);
    expect(logo.height).toBe(4);
    expect(logo.format).toBe("png");
    // Dev URL points at the live source via the /@image/ route
    expect(logo.src).toMatch(/^\/@image\/test\.png\?f=/);
    expect(logo.src).toContain(
      path.join(fixtureRoot, "src/assets/test.png"),
    );
  });

  test("emits a hashed /_astro/ URL in build mode", async () => {
    setImageMode("build", "/");
    const entries = await getCollection("items");
    const logo = entries[0].data.logo as { src: string };
    expect(logo.src).toMatch(/^\/_astro\/test\.[0-9a-f]{8}\.png$/);
  });

  test("validation fails for a missing image path", async () => {
    setImageMode("dev", "/");
    await writeConfig({
      items: defineCollection({
        loader: async () => [
          { id: "missing", name: "X", logo: "../does/not/exist.png", url: "u" },
        ],
        // function loader → no _filePath → image() must error clearly
        schema: ({ image }) =>
          z.object({
            name: z.string(),
            logo: image(),
            url: z.string(),
          }),
      }),
    });
    await initCollections(fixtureRoot);
    const entries = await getCollection("items");
    // Validation fails → entry is dropped
    expect(entries.length).toBe(0);
  });

  test("rejects root-absolute paths with a clear hint about public/", async () => {
    setImageMode("dev", "/");
    await fs.writeFile(
      path.join(fixtureRoot, "src/content/items/foo.md"),
      `---\nname: Foo\nlogo: /uploads/test.png\nurl: https://example.com\n---\n`,
    );
    await initCollections(fixtureRoot);
    const entries = await getCollection("items");
    expect(entries.length).toBe(0);
    const failures = getValidationFailures();
    expect(failures.length).toBe(1);
    expect(failures[0].errors).toContain("relative to the entry file");
    expect(failures[0].errors).toContain("public/");
    // Restore the fixture for subsequent tests
    await fs.writeFile(
      path.join(fixtureRoot, "src/content/items/foo.md"),
      `---\nname: Foo\nlogo: ../../assets/test.png\nurl: https://example.com\n---\n\nBody of foo.\n`,
    );
  });

  test("rejects remote URLs with a hint to use z.string().url()", async () => {
    setImageMode("dev", "/");
    await fs.writeFile(
      path.join(fixtureRoot, "src/content/items/foo.md"),
      `---\nname: Foo\nlogo: https://cdn.example.com/foo.png\nurl: https://example.com\n---\n`,
    );
    await initCollections(fixtureRoot);
    const entries = await getCollection("items");
    expect(entries.length).toBe(0);
    expect(getValidationFailures()[0].errors).toContain("z.string().url()");
    await fs.writeFile(
      path.join(fixtureRoot, "src/content/items/foo.md"),
      `---\nname: Foo\nlogo: ../../assets/test.png\nurl: https://example.com\n---\n\nBody of foo.\n`,
    );
  });

  test("memoizes image probe across entries sharing the same file", async () => {
    setImageMode("dev", "/");
    // Add a second entry that references the same logo
    await fs.writeFile(
      path.join(fixtureRoot, "src/content/items/bar.md"),
      `---\nname: Bar\nlogo: ../../assets/test.png\nurl: https://example.com\n---\n\nBody of bar.\n`,
    );
    await initCollections(fixtureRoot);
    const entries = await getCollection("items");
    expect(entries.length).toBe(2);
    const fooLogo = entries.find((e) => e.id === "foo")!.data.logo as { src: string };
    const barLogo = entries.find((e) => e.id === "bar")!.data.logo as { src: string };
    // Same file → same hashed URL (proves the probe was reused, not just re-run)
    expect(fooLogo.src).toBe(barLogo.src);
    await fs.unlink(path.join(fixtureRoot, "src/content/items/bar.md"));
  });

  test("static schema (non-function) still works", async () => {
    setImageMode("dev", "/");
    await writeConfig({
      items: defineCollection({
        loader: glob({ base: "src/content/items" }),
        schema: z.object({
          name: z.string(),
          logo: z.string(),
          url: z.string(),
        }),
      }),
    });
    await initCollections(fixtureRoot);
    const entries = await getCollection("items");
    expect(entries.length).toBe(1);
    // Without image(), logo is just the literal string
    expect(entries[0].data.logo).toBe("../../assets/test.png");
  });
});
