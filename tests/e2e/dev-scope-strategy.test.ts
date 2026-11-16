import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import path from "path";

// The dev server compiles an Astro project's `.astro` with Astro's default
// `attribute` strategy too, and still finds each component's scoped CSS.
const fixtureRoot = path.join(import.meta.dir, "../fixture-astro-scope-strategy");
const PORT = 5600 + Math.floor(Math.random() * 1000);
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

describe("dev server - scoped style strategy", () => {
  test("serves data-astro-cid markup with its attribute-scoped CSS", async () => {
    const html = await (await fetch(BASE + "/")).text();
    const cardScope = html.match(/<p class="card" data-astro-cid-([a-z0-9]+)>/)?.[1];
    expect(cardScope).toBeDefined();
    expect(html).toContain(`.card[data-astro-cid-${cardScope}]`);
    expect(html).not.toContain(":where(");
  });
});
