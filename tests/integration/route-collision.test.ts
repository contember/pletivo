import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import fs from "fs/promises";
import path from "path";
import { build } from "../../packages/pletivo/src/build";
import type { PletivoConfig } from "../../packages/pletivo/src/config";

const config: PletivoConfig = {
  host: "localhost",
  outDir: "dist",
  port: 3000,
  base: "/",
  srcDir: "src",
  publicDir: "public",
};

const dynamicPage = (name: string, paths: string[]) => `
export function getStaticPaths() {
  return ${JSON.stringify(paths)}.map((value) => ({ params: { ${name}: value }, props: { value } }));
}
export default function Page({ value }) {
  return <p>${name}: {value}</p>;
}
`;

// Inside the repo, so the pages compile with its JSX runtime.
const root = await fs.mkdtemp(path.join(import.meta.dir, "tmp-route-collision-"));
let warnings: string[] = [];

beforeAll(async () => {
  const pages = path.join(root, "src/pages");
  await fs.mkdir(pages, { recursive: true });
  await fs.writeFile(path.join(pages, "c.tsx"), "export default function C() { return <p>static c</p>; }\n");
  await fs.writeFile(path.join(pages, "[foo].tsx"), dynamicPage("foo", ["c", "d"]));
  await fs.writeFile(path.join(pages, "[bar].tsx"), dynamicPage("bar", ["c", "d"]));
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await build(root, config);
    warnings = warn.mock.calls.map((args) => args.map(String).join(" "));
  } finally {
    warn.mockRestore();
  }
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const page = (file: string) => Bun.file(path.join(root, "dist", file, "index.html")).text();

test("a path a static and a dynamic route build is the static route's", async () => {
  expect(await page("c")).toContain("static c");
});

test("a path two dynamic routes build is the one Astro sorts first", async () => {
  expect(await page("d")).toContain("bar: d");
  expect(warnings).toContain("  Skipping [foo].tsx [d]: d/index.html is built by the higher-priority route [bar].tsx");
});
