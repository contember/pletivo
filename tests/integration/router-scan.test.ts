import { describe, test, expect } from "bun:test";
import path from "path";
import { scanRoutes } from "../../src/router";

const fixturePages = path.join(import.meta.dir, "../fixture/src/pages");

describe("scanRoutes", () => {
  test("finds all page files", async () => {
    const routes = await scanRoutes(fixturePages);
    expect(routes.length).toBe(4);
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
});
