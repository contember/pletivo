// A pletivo-native project's sitemap lists the pages the build wrote: a param value may start
// with `_`, while 404, endpoints, public/ copies and pletivo's own output directories stay out.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "fs/promises";
import path from "path";

const cli = path.resolve(import.meta.dir, "../../packages/pletivo/src/cli.ts");

const runtime = path.resolve(import.meta.dir, "../../packages/runtime/src");
/** TSX pages and islands compile against pletivo's JSX runtime, as in a fixture's own tsconfig. */
const TSCONFIG = JSON.stringify({
  compilerOptions: {
    jsx: "react-jsx",
    jsxImportSource: "pletivo",
    paths: {
      "pletivo/jsx-runtime": [`${runtime}/jsx-runtime.ts`],
      "pletivo/jsx-dev-runtime": [`${runtime}/jsx-runtime.ts`],
      "preact/hooks": [`${runtime}/hooks.ts`],
    },
  },
});

const PROJECT: Record<string, string> = {
  "tsconfig.json": TSCONFIG,
  // `?url` copies the file under `_astro/`, so that directory holds an .html file too.
  "src/pages/index.tsx": `import Counter from "../islands/Counter";\nimport embed from "../embed.html?url";\nimport "../site.css";\n\nexport default function Page() {\n  return <html><body><a href={embed}>embed</a><Counter client="load" /></body></html>;\n}\n`,
  "src/islands/Counter.tsx": `export default function Counter() {\n  return <button>count</button>;\n}\n`,
  "src/embed.html": `<!DOCTYPE html><html><body>embed</body></html>\n`,
  // The page's stylesheet is bundled under `assets/`.
  "src/site.css": `body { color: red; }\n`,
  "src/pages/about.tsx": `export default function Page() {\n  return <html><body><p>about</p></body></html>;\n}\n`,
  "src/pages/blog/[slug].tsx": `export function getStaticPaths() {\n  return [{ params: { slug: "_private" } }, { params: { slug: "post" } }];\n}\n\nexport default function Page() {\n  return <html><body><p>post</p></body></html>;\n}\n`,
  "src/pages/404.tsx": `export default function Page() {\n  return <html><body><p>not found</p></body></html>;\n}\n`,
  "src/pages/widget.html.ts": `export function GET() {\n  return new Response("<p>widget</p>");\n}\n`,
  "public/verify.html": `verification\n`,
};

let root = "";
let build: { exitCode: number; output: string } = { exitCode: -1, output: "" };

beforeAll(async () => {
  // Inside the repo, so the project resolves pletivo's dependencies as a fixture does.
  root = await fs.mkdtemp(path.join(import.meta.dir, "tmp-sitemap-"));
  for (const [file, source] of Object.entries(PROJECT)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), source);
  }
  const child = Bun.spawn(["bun", cli, "build"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  build = { exitCode: await child.exited, output: stdout + stderr };
}, 120_000);

afterAll(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});

/** Every file the build wrote, relative to `dist/`. */
async function distFiles(): Promise<string[]> {
  if (build.exitCode !== 0) throw new Error(`the project failed to build:\n${build.output}`);
  const entries = await fs.readdir(path.join(root, "dist"), { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(path.join(root, "dist"), path.join(entry.parentPath, entry.name)))
    .sort();
}

async function sitemapUrls(): Promise<string[]> {
  if (build.exitCode !== 0) throw new Error(`the project failed to build:\n${build.output}`);
  const xml = await Bun.file(path.join(root, "dist/sitemap.xml")).text();
  return [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((match) => match[1]);
}

describe("sitemap.xml of a pletivo-native project", () => {
  test("the build wrote every kind of output the sitemap has to tell apart", async () => {
    const files = await distFiles();
    expect(files).toContain("blog/_private/index.html");
    expect(files).toContain("404.html");
    expect(files).toContain("widget.html");
    expect(files).toContain("verify.html");
    expect(files.some((file) => /^_islands\/Counter[^/]*\.js$/.test(file))).toBe(true);
    expect(files.some((file) => /^_astro\/embed\.[^/]+\.html$/.test(file))).toBe(true);
    expect(files.some((file) => /^assets\/[^/]+\.css$/.test(file))).toBe(true);
  });

  test("lists exactly the pages, a _-prefixed param value included", async () => {
    expect(await sitemapUrls()).toEqual(["/", "/about", "/blog/_private", "/blog/post"]);
  });
});
