// An Astro project's pages get Astro 5.16.11's doctype (`renderComponentToString`, `renderPage`):
// every page but a partial, unless its output already starts with one, with a newline after it
// only when `compressHTML` is off. A pletivo-native project keeps prefixing only pages that start
// with `<html`. Each project builds in its own process, since the MDX options are set once per process.
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

const ASTRO_PAGES: Record<string, string> = {
  "tsconfig.json": TSCONFIG,
  "src/layouts/Layout.astro": `<html lang="en"><head><title>Layout</title></head><body><slot /></body></html>\n`,
  "src/pages/index.mdx": `import Layout from "../layouts/Layout.astro";\n\n<Layout>\n# Wrapped\n</Layout>\n`,
  "src/pages/bare.astro": `<p>bare</p>\n<style>p { color: red; }</style>\n`,
  "src/pages/declared.astro": `<!doctype html>\n<html><head><title>Declared</title></head><body><p>declared</p></body></html>\n`,
  "src/pages/partial.astro": `---\nexport const partial = true;\n---\n<p>part</p>\n`,
  "src/pages/jsx.tsx": `export default function Page() {\n  return <html><body><p>jsx</p></body></html>;\n}\n`,
  "src/pages/notes.md": `# Notes\n`,
  "src/pages/posts/[slug].astro": `---\nexport function getStaticPaths() {\n  return [{ params: { slug: "one" } }];\n}\n---\n<p>post</p>\n`,
  "src/pages/fragments/[id].astro": `---\nexport const partial = true;\nexport function getStaticPaths() {\n  return [{ params: { id: "one" } }];\n}\n---\n<p>fragment</p>\n`,
  "src/pages/404.astro": `<p>missing</p>\n`,
  "src/pages/to-partial.astro": `---\nreturn Astro.rewrite("/partial");\n---\n`,
  "src/pages/partial-to-page.astro": `---\nexport const partial = true;\nreturn Astro.rewrite("/posts/one");\n---\n`,
};

const PROJECTS = {
  astro: { "astro.config.mjs": "export default {};\n", ...ASTRO_PAGES },
  uncompressed: { "astro.config.mjs": "export default { compressHTML: false };\n", ...ASTRO_PAGES },
  native: {
    "tsconfig.json": TSCONFIG,
    "src/pages/index.tsx": `export default function Page() {\n  return <html><body><p>native</p></body></html>;\n}\n`,
    "src/pages/fragment.tsx": `export default function Page() {\n  return <p>fragment</p>;\n}\n`,
  },
};
type Project = keyof typeof PROJECTS;
const NAMES: readonly Project[] = ["astro", "uncompressed", "native"];

const roots = new Map<Project, string>();
const builds = new Map<Project, { exitCode: number; output: string }>();

beforeAll(async () => {
  for (const name of NAMES) {
    // Inside the repo, so the project resolves pletivo's dependencies as a fixture does.
    const root = await fs.mkdtemp(path.join(import.meta.dir, `tmp-astro-doctype-${name}-`));
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

async function page(name: Project, file: string): Promise<string> {
  const result = builds.get(name);
  const root = roots.get(name);
  if (result?.exitCode !== 0 || root === undefined) throw new Error(`${name} failed to build:\n${result?.output}`);
  return Bun.file(path.join(root, "dist", file)).text();
}

describe("an Astro project's doctype", () => {
  test("goes before an MDX page's layout <html>, with no newline under the default compressHTML", async () => {
    expect(await page("astro", "index.html")).toStartWith('<!DOCTYPE html><html lang="en">');
  });

  test("is followed by a newline with compressHTML: false", async () => {
    expect(await page("uncompressed", "index.html")).toStartWith('<!DOCTYPE html>\n<html lang="en">');
  });

  test("goes on a page without <html>, before the CSS prepended to it", async () => {
    expect(await page("astro", "bare/index.html")).toStartWith("<!DOCTYPE html><style>");
    expect(await page("uncompressed", "bare/index.html")).toStartWith("<!DOCTYPE html>\n<style>");
    expect(await page("astro", "posts/one/index.html")).toStartWith("<!DOCTYPE html><p");
    expect(await page("astro", "404.html")).toStartWith("<!DOCTYPE html><p");
  });

  test("goes on a TSX page", async () => {
    expect(await page("astro", "jsx/index.html")).toStartWith("<!DOCTYPE html><html>");
  });

  test("is not doubled on a page that declares one", async () => {
    for (const name of ["astro", "uncompressed"] as const) {
      for (const file of ["declared/index.html", "notes/index.html"]) {
        const html = await page(name, file);
        expect(html).toStartWith("<!DOCTYPE html>");
        expect(html.match(/<!doctype/gi)).toHaveLength(1);
      }
    }
  });

  test("is not added to a partial", async () => {
    expect(await page("astro", "partial/index.html")).toBe("<p>part</p>");
    expect(await page("astro", "fragments/one/index.html")).toBe("<p>fragment</p>");
  });

  test("follows the rewrite target's partial, not the rewriting page's", async () => {
    expect(await page("astro", "to-partial/index.html")).toBe("<p>part</p>");
    expect(await page("astro", "partial-to-page/index.html")).toStartWith("<!DOCTYPE html><p");
  });
});

describe("a pletivo-native project's doctype", () => {
  test("goes, with a newline, only on a page that starts with <html>", async () => {
    expect(await page("native", "index.html")).toStartWith("<!DOCTYPE html>\n<html>");
    expect(await page("native", "fragment/index.html")).toStartWith("<p>fragment</p>");
  });
});
