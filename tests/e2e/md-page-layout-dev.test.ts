import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "path";
import { startDevServer, type DevServer } from "../support/dev-server";

// A `.md` page renders inside the layout its `layout:` names. An `.mdx` page's
// `layout:` is not applied yet, so dev says so on the error overlay instead of serving
// the page without its layout.
const fixtureRoot = path.join(import.meta.dir, "../fixture-md-page-layout");

let server: DevServer;
let BASE: string;

beforeAll(async () => {
  server = await startDevServer({ cwd: fixtureRoot, args: ["--no-restart"] });
  BASE = server.url;
});

afterAll(async () => {
  await server.stop();
});

describe("dev server - .md/.mdx page with layout: frontmatter", () => {
  test("a .md page renders inside its layout", async () => {
    const res = await fetch(BASE + "/about");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<html lang="en"');
    expect(html).toContain("<title>About</title>");
    expect(html).toContain("<p>A Markdown page inside its layout.</p>");
    expect(html).toMatch(/\.shell\[data-astro-cid-[a-z0-9]+\]\{color:rgb\(1,2,3\)\}/);
    expect(await (await fetch(BASE + "/__styles.css")).text()).toContain("background: rgb(4, 5, 6)");
    const script = html.match(/<script type="module" src="(\/_astro\/hoisted-[^"]+)"/);
    expect(script).not.toBeNull();
    expect(await (await fetch(BASE + (script?.[1] ?? ""))).text()).toContain("mdLayout");
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
