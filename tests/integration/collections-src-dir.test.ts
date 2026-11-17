// A project whose srcDir is `app/`: the content config, a collection without a loader and the
// route components integrations see all come from `app/`, not a hardcoded `src/`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "fs/promises";
import path from "path";

const cli = path.resolve(import.meta.dir, "../../packages/pletivo/src/cli.ts");

const PROJECT: Record<string, string> = {
  "pletivo.config.ts": `export default { srcDir: "app" };\n`,
  "astro.config.mjs": `import fs from "node:fs";
export default {
  srcDir: "./app",
  integrations: [{
    name: "record-routes",
    hooks: {
      "astro:routes:resolved": ({ routes }) => {
        fs.writeFileSync("routes.json", JSON.stringify(routes.map((route) => route.component)));
      },
    },
  }],
};
`,
  "app/content.config.ts": `import { defineCollection } from "astro:content";
export const collections = { posts: defineCollection({}) };
`,
  "app/content/posts/first.md": `---\ntitle: First post\n---\n\nHello.\n`,
  "app/content/posts/second.md": `---\ntitle: Second post\n---\n\nHello again.\n`,
  // What a hardcoded src/ would read instead.
  "src/content/posts/stray.md": `---\ntitle: Stray post\n---\n`,
  "app/pages/index.astro": `---
import { getCollection } from "astro:content";
const posts = await getCollection("posts");
let missing = "";
try {
  await getCollection("missing");
} catch (error) {
  missing = error.message;
}
---
<html><body><ul>{posts.map((post) => <li>{post.data.title}</li>)}</ul><p id="missing">{missing}</p></body></html>
`,
};

let root: string;
let result: { exitCode: number; output: string };

beforeAll(async () => {
  // Inside the repo, so the project resolves pletivo's dependencies as a fixture does.
  root = await fs.mkdtemp(path.join(import.meta.dir, "tmp-collections-src-dir-"));
  for (const [file, source] of Object.entries(PROJECT)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), source);
  }
  const child = Bun.spawn(["bun", cli, "build"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  result = { exitCode: await child.exited, output: stdout + stderr };
}, 60_000);

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("srcDir app/ with a content collection", () => {
  test("build succeeds", () => {
    expect(result.output).not.toContain("No files found");
    expect(result.exitCode).toBe(0);
  });

  test("the collection without a loader reads app/content/<name>", async () => {
    const html = await Bun.file(path.join(root, "dist/index.html")).text();
    expect(html).toContain("<li>First post</li><li>Second post</li>");
    expect(html).not.toContain("Stray post");
  });

  test("a missing collection's error names the content config under app/", async () => {
    const html = await Bun.file(path.join(root, "dist/index.html")).text();
    expect(html).toContain("Define it in app/content.config.ts or app/content/config.ts");
  });

  test("integrations see route components under app/pages", async () => {
    expect(JSON.parse(await Bun.file(path.join(root, "routes.json")).text())).toEqual(["app/pages/index.astro"]);
  });
});
