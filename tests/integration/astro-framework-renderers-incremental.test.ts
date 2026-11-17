/**
 * An incremental build that restores a page from the cache still bundles that page's islands:
 * the cache entry records the components the page hydrates.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "fs/promises";
import path from "path";

const root = path.join(import.meta.dir, "../fixture-astro-renderers-incremental");
const cli = path.resolve(import.meta.dir, "../../packages/pletivo/src/cli.ts");
const about = path.join(root, "src/pages/about.astro");
const dist = path.join(root, "dist");
let aboutSource = "";

async function build(...flags: string[]): Promise<string> {
  const child = Bun.spawn(["bun", cli, "build", ...flags], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const output = stdout + stderr;
  if ((await child.exited) !== 0) throw new Error(`pletivo build ${flags.join(" ")} failed:\n${output}`);
  return output;
}

function islandUrls(html: string): string[] {
  const island = html.match(/<astro-island [^>]*>/)?.[0] ?? "";
  return [...island.matchAll(/ (component-url|renderer-url)="([^"]+)"/g)].map((match) => match[2]);
}

beforeAll(async () => {
  aboutSource = await fs.readFile(about, "utf8");
});

afterAll(async () => {
  await fs.writeFile(about, aboutSource);
  await fs.rm(dist, { recursive: true, force: true });
});

test("a page restored from the cache keeps its island bundles", async () => {
  await build("--incremental", "--clean");
  const html = await fs.readFile(path.join(dist, "index.html"), "utf8");
  const urls = islandUrls(html);
  expect(urls).toHaveLength(2);

  await fs.writeFile(about, aboutSource.replace("<p>About</p>", "<p>About us</p>"));
  // `_astro/` outlives an incremental build, so remove it: the bundles must be rebuilt from the cache entry.
  await fs.rm(path.join(dist, "_astro"), { recursive: true, force: true });
  const output = await build("--incremental");

  expect(output).toContain("1 rendered + 1 cached");
  expect(await fs.readFile(path.join(dist, "index.html"), "utf8")).toBe(html);
  for (const url of urls) {
    expect({ url, exists: await Bun.file(path.join(dist, url)).exists() }).toEqual({ url, exists: true });
  }
}, 120_000);
