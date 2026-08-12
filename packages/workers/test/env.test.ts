import { afterAll, describe, expect, test } from "bun:test";
import { createAstroCompiler } from "../src/astro-compiler.ts";
import { compileProject } from "../src/compile-project.ts";
import {
  EnvNameError,
  EnvTooLargeError,
  ENV_BINDING,
  ENV_SERVER_MODULE_NAME,
  MAX_ENV_BYTES,
  type ProjectEnv,
} from "../src/env.ts";
import { renderPage } from "../src/render.ts";
import { astroWasmModule } from "./astro-wasm.ts";
import { FileLoader } from "./file-loader.ts";

/**
 * `astro:env` on the Workers host.
 *
 * The Bun host reads these off `process.env` against the schema in `astro.config.*`.
 * A Worker has neither, so the values come from the caller and land in the isolate's
 * `env` — and the thing worth testing is precisely that they land *there* and not in
 * the module map, because the map is what the isolate is content-addressed by.
 */

const compiler = createAstroCompiler(await astroWasmModule());
const loader = new FileLoader();
afterAll(() => loader.cleanup());

const SERVER_PAGE = `---
import { API_BASE, TOKEN } from "astro:env/server";
---
<html><body><p id="base">{API_BASE}</p><p id="token">{TOKEN}</p></body></html>
`;

const CLIENT_PAGE = `---
import { PUBLIC_NAME } from "astro:env/client";
---
<html><body><p id="name">{PUBLIC_NAME}</p></body></html>
`;

function project(page: string): Map<string, string> {
  return new Map<string, string>([["src/pages/index.astro", page]]);
}

function render(files: Map<string, string>, env?: ProjectEnv) {
  return renderPage({ files, pathname: "/", loader, compiler, env });
}

describe("astro:env values", () => {
  test("reach a page that imports astro:env/server", async () => {
    const page = await render(project(SERVER_PAGE), {
      server: { API_BASE: "https://api.example.test", TOKEN: "s3cret" },
    });
    expect(page.html).toContain('<p id="base">https://api.example.test</p>');
    expect(page.html).toContain('<p id="token">s3cret</p>');
  });

  test("let the server module see the client half too, as the Bun host does", async () => {
    // `generateEnvModule("server")` in astro-plugin.ts exports every field regardless
    // of its context; only the client module is filtered.
    const files = new Map<string, string>([
      [
        "src/pages/index.astro",
        `---
import { PUBLIC_NAME } from "astro:env/server";
---
<html><body><p id="name">{PUBLIC_NAME}</p></body></html>
`,
      ],
    ]);
    const page = await render(files, { client: { PUBLIC_NAME: "pletivo" } });
    expect(page.html).toContain('<p id="name">pletivo</p>');
  });

  test("keep a secret out of astro:env/client", async () => {
    const page = await render(project(CLIENT_PAGE), {
      client: { PUBLIC_NAME: "pletivo" },
      server: { PUBLIC_NAME: "leaked" },
    });
    expect(page.html).toContain('<p id="name">pletivo</p>');
  });

  test("arrive as undefined when the host has none, rather than failing to start", async () => {
    // What the Bun host does with an unset `process.env` entry. The alternative is a
    // module that does not export the name, which inside an isolate is a bundle that
    // will not start — a much worse report of "this variable is not set".
    const page = await render(project(SERVER_PAGE));
    expect(page.html).toContain('<p id="base"></p>');
  });

  test("are visible to a namespace import, which names nothing at the import site", async () => {
    const files = new Map<string, string>([
      [
        "src/pages/index.astro",
        `---
import * as env from "astro:env/server";
---
<html><body><p id="base">{env.API_BASE}</p></body></html>
`,
      ],
    ]);
    const page = await render(files, { server: { API_BASE: "https://api.example.test" } });
    expect(page.html).toContain('<p id="base">https://api.example.test</p>');
  });
});

describe("the module map", () => {
  test("carries the names and never the values", async () => {
    const { modules, env } = await compileProject(project(SERVER_PAGE), compiler);
    expect(env).toEqual({ client: null, server: ["API_BASE", "TOKEN"] });
    // The generated module is added per render, since only the caller has the values.
    expect(modules[ENV_SERVER_MODULE_NAME]).toBeUndefined();
  });

  test("does not change when a secret is rotated", async () => {
    const files = project(SERVER_PAGE);
    const first = await render(files, { server: { API_BASE: "https://one.test" } });
    const second = await render(files, { server: { API_BASE: "https://two.test" } });
    // Same sources, same names, same bundle — so a rotation recompiles nothing.
    expect(second.bundleId).toBe(first.bundleId);
    expect(second.html).toContain("https://two.test");
  });

  test("hands the values over in env, under the binding name", async () => {
    const files = project(SERVER_PAGE);
    const env = { server: { API_BASE: "https://api.example.test" } };
    await render(files, env);
    const code = [...loader.bundles.values()].at(-1);
    expect(code?.env).toEqual({ [ENV_BINDING]: { client: {}, server: env.server } });
    for (const source of Object.values(code?.modules ?? {})) {
      expect(source).not.toContain("https://api.example.test");
    }
  });

  test("is untouched for a project that never imports astro:env", async () => {
    const files = new Map<string, string>([
      ["src/pages/index.astro", `<html><body><p>page</p></body></html>\n`],
    ]);
    const { env, modules } = await compileProject(files, compiler);
    expect(env).toBe(null);
    expect(Object.keys(modules)).not.toContain(ENV_SERVER_MODULE_NAME);
    // And nothing is handed over, so the isolate keeps the env it always had: none.
    await render(files, { server: { API_BASE: "https://api.example.test" } });
    expect([...loader.bundles.values()].at(-1)?.env).toBeUndefined();
  });
});

describe("the 1 MiB cap on a dynamic Worker's env", () => {
  test("is checked against the values, before the isolate is asked for", async () => {
    const oversized = { server: { BLOB: "x".repeat(MAX_ENV_BYTES) } };
    const error = await render(project(SERVER_PAGE), oversized).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(EnvTooLargeError);
    expect(error).toMatchObject({ bytes: expect.any(Number) });
    expect(String(error)).toContain(String(MAX_ENV_BYTES));
  });

  test("lets everything under it through", async () => {
    const page = await render(project(SERVER_PAGE), {
      server: { API_BASE: "y".repeat(MAX_ENV_BYTES - 1024) },
    });
    expect(page.html).toContain("yyy");
  });

  test("rejects a name that cannot be an export", async () => {
    // The isolate exports each value as a JavaScript binding, so this cannot be
    // generated at all — and an isolate that refuses to start says so much less well.
    const files = project(SERVER_PAGE);
    const error = await render(files, { server: { "not-an-identifier": "x" } }).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(EnvNameError);
  });
});
