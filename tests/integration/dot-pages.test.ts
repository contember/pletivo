// As in Astro 5.16.11 (`createFileBasedRoutes`), a file or directory under `src/pages` whose name
// starts with `.` is not a route, except `.well-known`. Build and dev each run in their own process.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "fs/promises";
import path from "path";
import { startDevServer, type DevServer } from "../support/dev-server";

const cli = path.resolve(import.meta.dir, "../../packages/pletivo/src/cli.ts");

const SECURITY_TXT = "Contact: mailto:security@example.com\n";

const FILES = {
  "astro.config.mjs": "export default {};\n",
  "src/pages/index.astro": `<html><body><p>home</p></body></html>\n`,
  "src/pages/.well-known/security.txt.ts": `export function GET() {\n  return new Response(${JSON.stringify(SECURITY_TXT)});\n}\n`,
  "src/pages/.well-known/about.astro": `<html><body><p>well-known page</p></body></html>\n`,
  "src/pages/.well-known/.hidden.txt.ts": `export function GET() {\n  return new Response("hidden");\n}\n`,
  "src/pages/.well-known/_draft.astro": `<html><body><p>draft</p></body></html>\n`,
  "src/pages/.hidden.astro": `<html><body><p>hidden</p></body></html>\n`,
  "src/pages/.hidden/x.astro": `<html><body><p>hidden x</p></body></html>\n`,
  "src/pages/_draft.astro": `<html><body><p>draft</p></body></html>\n`,
};

/** Paths no host may serve: the `.` rule, and the `_` rule inside and outside `.well-known`. */
const NOT_ROUTES = ["/.hidden", "/.hidden/x", "/.well-known/.hidden.txt", "/.well-known/_draft", "/_draft"];

let root = "";
let build = { exitCode: -1, output: "" };

beforeAll(async () => {
  // Inside the repo, so the project resolves pletivo's dependencies as a fixture does.
  root = await fs.mkdtemp(path.join(import.meta.dir, "tmp-dot-pages-"));
  for (const [file, source] of Object.entries(FILES)) {
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

/** Every file the build wrote, relative to `dist/`, outside pletivo's own asset directories. */
async function distFiles(): Promise<string[]> {
  if (build.exitCode !== 0) throw new Error(`build failed:\n${build.output}`);
  const dist = path.join(root, "dist");
  const entries = await fs.readdir(dist, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dist, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .filter((file) => !/^_(astro|islands)\//.test(file))
    .sort();
}

describe(".-prefixed files under src/pages, build", () => {
  test("only .well-known is routed: its endpoint and its page are emitted, nothing else", async () => {
    expect(await distFiles()).toEqual([".well-known/about/index.html", ".well-known/security.txt", "index.html"]);
  });

  test("the .well-known endpoint writes its body verbatim", async () => {
    expect(await Bun.file(path.join(root, "dist/.well-known/security.txt")).text()).toBe(SECURITY_TXT);
  });
});

describe(".-prefixed files under src/pages, dev", () => {
  let server: DevServer | null = null;
  let base = "";

  beforeAll(async () => {
    server = await startDevServer({ cwd: root, args: ["--no-restart"], timeoutMs: 25_000 });
    base = server.url;
  }, 30_000);

  afterAll(async () => {
    await server?.stop();
  });

  test("serves the .well-known endpoint at its path", async () => {
    const res = await fetch(`${base}/.well-known/security.txt`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(SECURITY_TXT);
  });

  test("serves the .well-known page", async () => {
    const res = await fetch(`${base}/.well-known/about`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<p>well-known page</p>");
  });

  test("404s every other . or _ entry", async () => {
    for (const pathname of NOT_ROUTES) {
      expect({ pathname, status: (await fetch(base + pathname)).status }).toEqual({ pathname, status: 404 });
    }
  });
});
