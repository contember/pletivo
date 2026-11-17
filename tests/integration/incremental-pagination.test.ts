/**
 * The first page of a paginated `[...page]` route has params `{ page: undefined }`.
 * The incremental cache stores param sets as JSON, which drops that key, so a warm
 * build must still match the cached slug to its route entry and its props.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "fs/promises";
import os from "os";
import path from "path";

const cli = path.resolve(import.meta.dir, "../../packages/pletivo/src/cli.ts");

const PAGE = `---
export async function getStaticPaths({ paginate }) {
  const posts = Array.from({ length: 7 }, (_, i) => ({ title: "Post " + (i + 1) }));
  return paginate(posts, { pageSize: 2 });
}
const { page } = Astro.props;
---
<html>
  <head><title>Blog {page.currentPage}</title></head>
  <body>
    <h1>Page {page.currentPage} of {page.lastPage}</h1>
    <p id="params">{JSON.stringify(Astro.params)}</p>
    <ul>{page.data.map((post) => <li>{post.title}</li>)}</ul>
    {page.url.prev && <a rel="prev" href={page.url.prev}>prev</a>}
    {page.url.next && <a rel="next" href={page.url.next}>next</a>}
  </body>
</html>
`;

const PAGES = ["blog/index.html", "blog/2/index.html", "blog/3/index.html", "blog/4/index.html"];

let incrementalRoot = "";
let fullRoot = "";

async function createProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pletivo-inc-paginate-"));
  await fs.mkdir(path.join(root, "src/pages/blog"), { recursive: true });
  await fs.writeFile(path.join(root, "src/pages/blog/[...page].astro"), PAGE);
  return root;
}

async function build(root: string, ...flags: string[]): Promise<string> {
  const child = Bun.spawn(["bun", cli, "build", ...flags], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const output = stdout + stderr;
  if ((await child.exited) !== 0) throw new Error(`pletivo build ${flags.join(" ")} failed:\n${output}`);
  return output;
}

async function readPages(root: string): Promise<Record<string, string>> {
  const pages: Record<string, string> = {};
  for (const page of PAGES) pages[page] = await fs.readFile(path.join(root, "dist", page), "utf8");
  return pages;
}

async function listHtml(root: string): Promise<string[]> {
  const files = await fs.readdir(path.join(root, "dist"), { recursive: true });
  return files.filter((file) => file.endsWith(".html")).sort();
}

beforeEach(async () => {
  incrementalRoot = await createProject();
  fullRoot = await createProject();
});

afterEach(async () => {
  await fs.rm(incrementalRoot, { recursive: true, force: true });
  await fs.rm(fullRoot, { recursive: true, force: true });
});

test("a second incremental build reuses every page of a paginated rest route", async () => {
  await build(incrementalRoot, "--incremental");
  const output = await build(incrementalRoot, "--incremental");
  await build(fullRoot);

  expect(output).toContain("0 rendered + 4 cached");
  expect(await listHtml(incrementalRoot)).toEqual(await listHtml(fullRoot));
  expect(await readPages(incrementalRoot)).toEqual(await readPages(fullRoot));
}, 120_000);

test("a page rendered from cached param sets gets its getStaticPaths props", async () => {
  await build(incrementalRoot, "--incremental");
  // A cached entry whose output is gone re-renders from the cached param sets.
  for (const page of PAGES) await fs.rm(path.join(incrementalRoot, "dist", page));
  const output = await build(incrementalRoot, "--incremental");
  await build(fullRoot);

  expect(output).toContain("4 rendered + 0 cached");
  expect(await listHtml(incrementalRoot)).toEqual(await listHtml(fullRoot));
  expect(await readPages(incrementalRoot)).toEqual(await readPages(fullRoot));
}, 120_000);
