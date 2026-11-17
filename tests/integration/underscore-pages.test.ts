// As in Astro 5.16.11 (`createFileBasedRoutes`), a file or directory under `src/pages` whose name
// starts with `_` is not a route, in an Astro project and a pletivo-native one alike. Such a file
// can still be imported by a page. Each project builds in its own process.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "fs/promises";
import path from "path";

const cli = path.resolve(import.meta.dir, "../../packages/pletivo/src/cli.ts");

const runtime = path.resolve(import.meta.dir, "../../packages/runtime/src");
/** TSX pages compile against pletivo's JSX runtime, as in a fixture's own tsconfig. */
const TSCONFIG = JSON.stringify({
  compilerOptions: {
    jsx: "react-jsx",
    jsxImportSource: "pletivo",
    paths: {
      "pletivo/jsx-runtime": [`${runtime}/jsx-runtime.ts`],
      "pletivo/jsx-dev-runtime": [`${runtime}/jsx-runtime.ts`],
    },
  },
});

const PROJECTS = {
  astro: {
    "astro.config.mjs": "export default {};\n",
    "src/pages/index.astro": `---\nimport Card from "./_components/Card.astro";\n---\n<html><body><Card /></body></html>\n`,
    "src/pages/_components/Card.astro": `<p class="card">card</p>\n`,
    "src/pages/_draft.astro": `<html><body><p>draft</p></body></html>\n`,
    "src/pages/_notes.md": `---\nlayout: ../layouts/Missing.astro\n---\n\n# Notes\n`,
    "src/pages/_[slug].astro": `---\nexport function getStaticPaths() {\n  return [{ params: { slug: "one" } }];\n}\n---\n<p>hidden</p>\n`,
    "src/pages/_feed.xml.ts": `export function GET() {\n  return new Response("<feed/>");\n}\n`,
    "src/pages/blog/[slug].astro": `---\nexport function getStaticPaths() {\n  return [{ params: { slug: "post" } }];\n}\n---\n<p>post</p>\n`,
    "src/pages/blog/_drafts/next.md": `# Next\n`,
    "src/pages/feed.xml.ts": `export function GET() {\n  return new Response("<feed/>");\n}\n`,
  },
  native: {
    "tsconfig.json": TSCONFIG,
    "src/pages/index.tsx": `import Card from "./_components/Card";\n\nexport default function Page() {\n  return <html><body><Card /></body></html>;\n}\n`,
    "src/pages/_components/Card.tsx": `export default function Card() {\n  return <p class="card">card</p>;\n}\n`,
    "src/pages/_draft.tsx": `export default function Page() {\n  return <html><body><p>draft</p></body></html>;\n}\n`,
    "src/pages/about.tsx": `export default function Page() {\n  return <html><body><p>about</p></body></html>;\n}\n`,
  },
};
type Project = keyof typeof PROJECTS;
const NAMES: readonly Project[] = ["astro", "native"];

const roots = new Map<Project, string>();
const builds = new Map<Project, { exitCode: number; output: string }>();

beforeAll(async () => {
  for (const name of NAMES) {
    // Inside the repo, so the project resolves pletivo's dependencies as a fixture does.
    const root = await fs.mkdtemp(path.join(import.meta.dir, `tmp-underscore-pages-${name}-`));
    roots.set(name, root);
    for (const [file, source] of Object.entries(PROJECTS[name])) {
      await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await fs.writeFile(path.join(root, file), source);
    }
    const child = Bun.spawn(["bun", cli, "build"], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    builds.set(name, { exitCode: await child.exited, output: stdout + stderr });
  }
}, 120_000);

afterAll(async () => {
  await Promise.all([...roots.values()].map((root) => fs.rm(root, { recursive: true, force: true })));
});

/** Every file the build wrote, relative to `dist/`. */
async function distFiles(name: Project): Promise<string[]> {
  const result = builds.get(name);
  const root = roots.get(name);
  if (result?.exitCode !== 0 || root === undefined) throw new Error(`${name} failed to build:\n${result?.output}`);
  const entries = await fs.readdir(path.join(root, "dist"), { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(path.join(root, "dist"), path.join(entry.parentPath, entry.name)))
    .sort();
}

async function distText(name: Project, file: string): Promise<string> {
  const root = roots.get(name);
  if (root === undefined) throw new Error(`${name} was not set up`);
  return Bun.file(path.join(root, "dist", file)).text();
}

describe("_-prefixed files under src/pages", () => {
  test("an Astro project emits no route for them, and still imports them", async () => {
    expect((await distFiles("astro")).filter((file) => file.endsWith(".html") || file.endsWith(".xml"))).toEqual([
      "blog/post/index.html",
      "feed.xml",
      "index.html",
    ]);
    expect(await distText("astro", "index.html")).toContain('<p class="card">card</p>');
  });

  test("a pletivo-native project emits no route for them, and still imports them", async () => {
    expect((await distFiles("native")).filter((file) => file.endsWith(".html"))).toEqual([
      "about/index.html",
      "index.html",
    ]);
    expect(await distText("native", "index.html")).toContain('<p class="card">card</p>');
  });

  test("no output path has a _-prefixed segment outside pletivo's own asset directories", async () => {
    for (const name of NAMES) {
      const files = (await distFiles(name)).filter((file) => !/^_(astro|islands)\//.test(file));
      expect(files.filter((file) => file.split(path.sep).some((part) => part.startsWith("_")))).toEqual([]);
    }
  });
});
