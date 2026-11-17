import { describe, test, expect } from "bun:test";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { scanRoutes } from "../../packages/pletivo/src/router";

const fixturePages = path.join(import.meta.dir, "../fixture/src/pages");

describe("scanRoutes", () => {
  test("finds all page files", async () => {
    const routes = await scanRoutes(fixturePages);
    expect(routes.length).toBe(6);
  });

  test("static routes come before dynamic", async () => {
    const routes = await scanRoutes(fixturePages);
    const dynamicIndex = routes.findIndex((r) => r.isDynamic);
    const lastStaticIndex = routes.findLastIndex((r) => !r.isDynamic);

    if (dynamicIndex !== -1 && lastStaticIndex !== -1) {
      expect(lastStaticIndex).toBeLessThan(dynamicIndex);
    }
  });

  test("includes expected routes", async () => {
    const routes = await scanRoutes(fixturePages);
    const files = routes.map((r) => r.file).sort();
    expect(files).toContain("index.tsx");
    expect(files).toContain("about.tsx");
    expect(files).toContain("blog/index.tsx");
    expect(files).toContain("blog/[slug].tsx");
  });

  test("correctly identifies dynamic routes", async () => {
    const routes = await scanRoutes(fixturePages);
    const slugRoute = routes.find((r) => r.file === "blog/[slug].tsx");
    expect(slugRoute).toBeDefined();
    expect(slugRoute!.isDynamic).toBe(true);
  });

  test("skips _-prefixed files and directories, as Astro does", async () => {
    const pages = await fs.mkdtemp(path.join(os.tmpdir(), "pletivo-router-scan-"));
    try {
      const files = [
        "index.astro",
        "_draft.md",
        "_components/Card.astro",
        "blog/[slug].astro",
        "blog/_drafts/post.md",
        "_[id].astro",
        "feed.xml.ts",
        "_data.json.ts",
      ];
      for (const file of files) {
        await fs.mkdir(path.dirname(path.join(pages, file)), { recursive: true });
        await fs.writeFile(path.join(pages, file), "");
      }
      const routes = await scanRoutes(pages);
      expect(routes.map((r) => r.file).sort()).toEqual(["blog/[slug].astro", "feed.xml.ts", "index.astro"]);
    } finally {
      await fs.rm(pages, { recursive: true, force: true });
    }
  });
});
