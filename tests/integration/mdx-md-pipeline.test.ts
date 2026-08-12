/**
 * End-to-end coverage for the runtime-critical plumbing that unit tests can't
 * reach: the Bun `onLoad` stub that intercepts `@astrojs/mdx`, and real remark
 * plugins (plus GFM) actually transforming `.mdx` and `.md` through the live
 * compile/parse paths. These exercise Bun plugin internals, so they belong in
 * an integration test rather than a pure-function unit test.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import path from "path";
import { pathToFileURL } from "url";
import {
  registerMdxPlugin,
  configureMdx,
  captureMdxIntegrationOptions,
} from "../../packages/pletivo/src/mdx-plugin";
import { configureMarkdown, parseMarkdown } from "@pletivo/core/content/markdown";

// A real remark plugin: rewrites the text "MARK" to "DONE" in the mdast tree.
const remarkMark = () => (tree: any) => {
  const walk = (node: any) => {
    if (node.type === "text" && typeof node.value === "string") {
      node.value = node.value.replace("MARK", "DONE");
    }
    (node.children ?? []).forEach(walk);
  };
  walk(tree);
};

let dir: string;

beforeAll(async () => {
  // Inside the repo (not the OS tmpdir): Bun's `.mdx` onLoad loader applies to
  // files within the project tree, matching how the build imports them.
  dir = mkdtempSync(path.join(import.meta.dir, "tmp-pipeline-"));
  await registerMdxPlugin();
});

afterAll(() => {
  // Reset the module-global plugin config so it can't leak into other suites
  // sharing the process.
  configureMdx({});
  configureMarkdown({});
  rmSync(dir, { recursive: true, force: true });
});

async function renderDefault(mod: any): Promise<string> {
  let rendered: any = mod.default({});
  if (rendered instanceof Promise) rendered = await rendered;
  return rendered && typeof rendered === "object" && "__html" in rendered
    ? (rendered as { __html: string }).__html
    : String(rendered);
}

describe("@astrojs/mdx Bun stub", () => {
  test("intercepts the package import and exposes mdx() options instead of running it", async () => {
    const pkgDir = path.join(dir, "node_modules", "@astrojs", "mdx");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "@astrojs/mdx", version: "0.0.0", type: "module", main: "index.mjs" }),
    );
    // A real-looking integration whose hook would throw if it ever ran — proves
    // the stub replaced it (the stub returns no hooks).
    writeFileSync(
      path.join(pkgDir, "index.mjs"),
      `export default function mdx() {
        return { name: "@astrojs/mdx", hooks: { "astro:config:setup"() { throw new Error("real @astrojs/mdx ran"); } } };
      }`,
    );

    const mod: any = await import(path.join(pkgDir, "index.mjs"));
    const remarkPlugin = () => {};
    const integration = mod.default({ remarkPlugins: [remarkPlugin], gfm: false, optimize: true });

    // Stub fired: options surfaced, no real hooks.
    expect(integration.__pletivoMdxOptions).toBeDefined();
    expect(integration.hooks).toBeUndefined();

    const captured = captureMdxIntegrationOptions(integration);
    expect(captured?.remarkPlugins).toEqual([remarkPlugin]);
    expect(captured?.gfm).toBe(false);
    expect(captured?.unsupportedKeys).toEqual(["optimize"]);
  });
});

describe(".mdx compilation", () => {
  test("applies a configured remark plugin and GFM to a real .mdx import", async () => {
    configureMdx({ remarkPlugins: [remarkMark], gfm: true });
    const file = path.join(dir, "page.mdx");
    writeFileSync(file, "# Hi\n\nMARK\n\n| A | B |\n| - | - |\n| 1 | 2 |\n");

    // Import the way the build does — file URL + cache-bust query (the .mdx
    // onLoad filter matches the `?...` suffix).
    const html = await renderDefault(await import(`${pathToFileURL(file).href}?v=test`));
    expect(html).toContain("DONE"); // remark plugin ran
    expect(html).not.toContain("MARK");
    expect(html).toContain("<table>"); // GFM ran (prepended remark-gfm)
  });
});

describe(".md unified pipeline", () => {
  test("applies a configured remark plugin and GFM to a real .md parse", async () => {
    configureMarkdown({ remarkPlugins: [remarkMark], gfm: true });
    const { html } = await parseMarkdown("---\ntitle: t\n---\n\nMARK\n\n~~gone~~\n");
    expect(html).toContain("DONE"); // remark plugin ran
    expect(html).not.toContain("MARK");
    expect(html).toContain("<del>gone</del>"); // GFM ran
  });
});
