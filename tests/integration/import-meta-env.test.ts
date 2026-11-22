import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import path from "path";
import { startDevServer, type DevServer } from "../support/dev-server";
import fs from "fs/promises";
import { build } from "../../packages/pletivo/src/build";
import { __resetForTests } from "../../packages/pletivo/src/astro-host/runner";
import type { PletivoConfig } from "../../packages/pletivo/src/config";

const astroFixture = path.join(import.meta.dir, "../fixture-astro-import-meta-env");
const nativeFixture = path.join(import.meta.dir, "../fixture-native-import-meta-env");

const config: PletivoConfig = {
  host: "localhost",
  outDir: "dist",
  port: 3000,
  base: "/",
  srcDir: "src",
  publicDir: "public",
};

function textOf(html: string, id: string): string {
  const match = html.match(new RegExp(`id="${id}"[^>]*>([^<]*)<`));
  if (!match) throw new Error(`#${id} not found in ${html}`);
  return match[1].replaceAll("&quot;", '"');
}

describe("import.meta.env in an Astro project build", () => {
  let index: string;
  let notes: string;

  beforeAll(async () => {
    __resetForTests();
    process.env.PUBLIC_FIXTURE_VAR = "from-env";
    await build(astroFixture, config);
    index = await Bun.file(path.join(astroFixture, "dist", "index.html")).text();
    notes = await Bun.file(path.join(astroFixture, "dist", "notes", "index.html")).text();
  });

  afterAll(async () => {
    __resetForTests();
    delete process.env.PUBLIC_FIXTURE_VAR;
    await fs.rm(path.join(astroFixture, "dist"), { recursive: true, force: true });
  });

  test("a plain .ts module sees Astro's built-ins and the process env", () => {
    expect(JSON.parse(textOf(index, "module"))).toEqual({
      base: "/docs",
      mode: "production",
      dev: false,
      prod: true,
      ssr: true,
      site: "https://example.com",
      publicVar: "from-env",
    });
  });

  test("an .astro component sees the same values", () => {
    expect(textOf(index, "astro")).toBe("/docs|production");
  });

  test("an .mdx page sees the same values", () => {
    expect(textOf(notes, "mdx")).toBe("/docs|true");
  });

  test("text that mentions import.meta.env renders as written", () => {
    expect(textOf(index, "astro-text")).toBe("Read import.meta.env.BASE_URL in a component.");
    expect(textOf(index, "module-text")).toBe("import.meta.env.BASE_URL");
    expect(notes).toContain("<code>import.meta.env.BASE_URL</code>");
    // The code block is highlighted, as Astro's is: its text is split across spans.
    const codeBlock = notes.match(/<pre[^>]*>([\s\S]*?)<\/pre>/)?.[1] ?? "";
    expect(codeBlock.replace(/<[^>]+>/g, "")).toBe("const base = import.meta.env.BASE_URL;");
  });
});

describe("import.meta.env in a pletivo-native project build", () => {
  let index: string;

  beforeAll(async () => {
    __resetForTests();
    await build(nativeFixture, { ...config, base: "/sub" });
    index = await Bun.file(path.join(nativeFixture, "dist", "index.html")).text();
  });

  afterAll(async () => {
    __resetForTests();
    await fs.rm(path.join(nativeFixture, "dist"), { recursive: true, force: true });
  });

  test("BASE_URL comes from pletivo's base, in .ts and .mjs modules", () => {
    expect(JSON.parse(textOf(index, "env"))).toEqual({
      base: "/sub",
      mode: "production",
      dev: false,
      modeFromMjs: "production",
    });
  });

  test("a .js module with JSX builds", () => {
    expect(index).toContain('<span id="badge">production</span>');
  });
});

describe("import.meta.env under pletivo dev", () => {
  const servers: DevServer[] = [];
  let astroIndex: string;
  let nativeIndex: string;

  async function devPage(cwd: string, pathname: string): Promise<string> {
    const server = await startDevServer({ cwd, args: ["--host", "127.0.0.1", "--no-restart"], timeoutMs: 45_000 });
    servers.push(server);
    return fetchWhenUp(`${server.url}${pathname}`);
  }

  beforeAll(async () => {
    [astroIndex, nativeIndex] = await Promise.all([
      devPage(astroFixture, "/docs"),
      devPage(nativeFixture, "/"),
    ]);
  }, 60_000);

  afterAll(async () => {
    await Promise.all(servers.map((server) => server.stop()));
  });

  test("modules see the development built-ins", () => {
    const fromModule = JSON.parse(textOf(astroIndex, "module"));
    expect(fromModule).toMatchObject({ base: "/docs", mode: "development", dev: true, prod: false });
    expect(textOf(astroIndex, "astro")).toBe("/docs|development");
  });

  test("a .js module with JSX loads", () => {
    expect(nativeIndex).toContain('<span id="badge">development</span>');
  });
});

/** The page body once the dev server answers it with a 200. */
async function fetchWhenUp(url: string): Promise<string> {
  const deadline = Date.now() + 50_000;
  while (Date.now() < deadline) {
    const response = await fetch(url).catch(() => undefined);
    if (response?.ok) return await response.text();
    await Bun.sleep(250);
  }
  throw new Error(`dev server did not serve ${url} in time`);
}
