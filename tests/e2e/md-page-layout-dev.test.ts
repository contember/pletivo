import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "path";

// A `.md`/`.mdx` page's `layout:` is not applied by pletivo yet. Dev must say so on
// the error overlay instead of serving the page without its layout.
const fixtureRoot = path.join(import.meta.dir, "../fixture-md-page-layout");
const PORT = 6789 + Math.floor(Math.random() * 1000);
const BASE = `http://localhost:${PORT}`;

let serverProcess: ReturnType<typeof Bun.spawn>;

beforeAll(async () => {
  serverProcess = Bun.spawn(
    ["bun", "run", path.join(import.meta.dir, "../../packages/pletivo/src/cli.ts"), "dev", String(PORT), "--no-restart"],
    { cwd: fixtureRoot, stdout: "pipe", stderr: "pipe" },
  );

  for (let i = 0; i < 50; i++) {
    try {
      await fetch(BASE);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("Dev server did not start in time");
});

afterAll(() => {
  serverProcess.kill();
});

describe("dev server - .md/.mdx page with layout: frontmatter", () => {
  test("the error overlay names a .md page and `layout:`", async () => {
    const html = await (await fetch(BASE + "/about")).text();
    expect(html).toContain("src/pages/about.md: `layout:` in frontmatter is not supported by pletivo yet");
    expect(html).not.toContain("A Markdown page whose layout pletivo does not apply yet.");
  });

  test("the error overlay names a .mdx page and `layout:`", async () => {
    const html = await (await fetch(BASE + "/guide")).text();
    expect(html).toContain("src/pages/guide.mdx: `layout:` in frontmatter is not supported by pletivo yet");
    expect(html).not.toContain("An MDX page whose layout pletivo does not apply yet.");
  });

  test("a collection entry and an imported .mdx with a layout field still render", async () => {
    const res = await fetch(BASE + "/posts");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-layout="wide"');
    expect(html).toContain("Collection body text.");
    expect(html).toContain("Imported MDX note text.");
  });
});
