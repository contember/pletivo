import { describe, expect, test } from "bun:test";
import * as collections from "@pletivo/core/content/collection";
import * as images from "@pletivo/core/image";
import { parseRoute, type Route } from "@pletivo/core/router";
import { createComponent, render } from "@pletivo/runtime/astro-shim";
import {
  createIsolateEntry,
  resolveFrom,
  type IsolateProgram,
  type PageModule,
} from "../src/isolate-entry.ts";
import {
  ISOLATE_PROTOCOL_VERSION,
  parseIsolateResponse,
  type IsolateParamPair,
  type IsolateRequest,
  type IsolateResponse,
} from "../src/isolate-protocol.ts";
import type { ContentBinding } from "../src/content-files.ts";

const INDEX = "src/pages/index.tsx";
const ASTRO_INDEX = "src/pages/about.astro";
const PAGED = "src/pages/[...page].tsx";
const ON_DEMAND = "src/pages/live.tsx";

function pageText(props: Record<string, unknown>): string {
  const context = props.__pageContext;
  const params = typeof context === "object" && context !== null ? Reflect.get(context, "params") : undefined;
  const page = typeof params === "object" && params !== null ? Reflect.get(params, "page") : "none";
  const hasPage = typeof params === "object" && params !== null && Object.hasOwn(params, "page");
  return `<p>n=${String(props.n)} page=${String(page)} has=${hasPage}</p>`;
}

const pagedModule: PageModule = {
  default: pageText,
  getStaticPaths: () => [
    { params: { page: undefined }, props: { n: 1 } },
    { params: { page: "2" }, props: { n: 2 } },
  ],
};

function program(pages: Record<string, PageModule>): IsolateProgram {
  const loaders: Record<string, () => Promise<PageModule>> = {};
  for (const [file, module] of Object.entries(pages)) loaders[file] = async () => module;
  return {
    pages: loaders,
    contentConfig: null,
    content: null,
    envInstallers: [],
    importMetaEnv: false,
  };
}

const PROGRAM = program({
  [INDEX]: { default: () => "<h1>home</h1>" },
  [ASTRO_INDEX]: {
    default: createComponent(async (_result, props) => render`<p>${String(props.title)}</p>`, "about"),
  },
  [PAGED]: pagedModule,
  [ON_DEMAND]: { default: () => "<p>live</p>", prerender: false },
});

function routeOf(file: string): Route {
  return parseRoute(file.slice("src/pages/".length));
}

async function callWith(
  entryProgram: IsolateProgram,
  body: IsolateRequest,
  env: unknown = {},
): Promise<IsolateResponse> {
  const request = new Request("http://pletivo.invalid/render", {
    method: "POST",
    body: JSON.stringify(body),
  });
  const response = await createIsolateEntry(entryProgram).fetch(request, env);
  expect(response.ok).toBe(true);
  return parseIsolateResponse(await response.json());
}

function call(body: IsolateRequest, env: unknown = {}): Promise<IsolateResponse> {
  return callWith(PROGRAM, body, env);
}

/** The paths op over one dynamic page whose `getStaticPaths` returns `result`. */
function pathsOf(result: unknown): Promise<IsolateResponse> {
  const pages = program({ [PAGED]: { default: pageText, getStaticPaths: () => result } });
  return callWith(pages, {
    protocol: ISOLATE_PROTOCOL_VERSION,
    op: "paths",
    routes: [{ file: PAGED, route: routeOf(PAGED) }],
  });
}

function errorMessage(response: IsolateResponse): string {
  if (response.status !== "error") throw new Error(`expected an error, got ${response.status}`);
  return response.message;
}

function renderRequest(file: string, params: IsolateParamPair[], route: Route | null): IsolateRequest {
  return {
    protocol: ISOLATE_PROTOCOL_VERSION,
    op: "render",
    file,
    params,
    route,
    url: "http://localhost/",
  };
}

describe("isolate entry", () => {
  test("renders a static page", async () => {
    expect(await call(renderRequest(INDEX, [], null))).toEqual({
      protocol: ISOLATE_PROTOCOL_VERSION,
      status: "rendered",
      html: "<h1>home</h1>",
      renderedModules: [],
      tsxStyles: [],
    });
  });

  test("renders an Astro page and records its module", async () => {
    const response = await call(renderRequest(ASTRO_INDEX, [], null));
    expect(response).toMatchObject({ status: "rendered", html: "<p>undefined</p>", renderedModules: ["about"] });
  });

  test("renders a dynamic route whose rest param is undefined", async () => {
    const response = await call(renderRequest(PAGED, [["page", null]], routeOf(PAGED)));
    expect(response).toMatchObject({ status: "rendered", html: "<p>n=1 page=undefined has=true</p>" });
  });

  test("renders the getStaticPaths entry a defined param names", async () => {
    const response = await call(renderRequest(PAGED, [["page", "2"]], routeOf(PAGED)));
    expect(response).toMatchObject({ status: "rendered", html: "<p>n=2 page=2 has=true</p>" });
  });

  test("answers no-static-path when getStaticPaths lists no such params", async () => {
    expect(await call(renderRequest(PAGED, [["page", "9"]], routeOf(PAGED)))).toEqual({
      protocol: ISOLATE_PROTOCOL_VERSION,
      status: "unresolved",
      reason: "no-static-path",
    });
  });

  test("answers not-enumerable for a dynamic route without getStaticPaths", async () => {
    const response = await call(renderRequest(INDEX, [["slug", "a"]], parseRoute("[slug].tsx")));
    expect(response).toMatchObject({ status: "unresolved", reason: "not-enumerable" });
  });

  test("rejects a page that exports prerender = false", async () => {
    const response = await call(renderRequest(ON_DEMAND, [], null));
    expect(response.status).toBe("error");
    if (response.status !== "error") return;
    expect(response.message).toBe(
      `${ON_DEMAND} exports prerender = false, which this static Worker host rejects`,
    );
  });

  test("lists param sets for the paths op, and skips routes that declare none", async () => {
    const response = await call({
      protocol: ISOLATE_PROTOCOL_VERSION,
      op: "paths",
      routes: [
        { file: INDEX, route: routeOf(INDEX) },
        { file: PAGED, route: routeOf(PAGED) },
      ],
    });
    expect(response).toEqual({
      protocol: ISOLATE_PROTOCOL_VERSION,
      status: "paths",
      paths: { [PAGED]: [[["page", null]], [["page", "2"]]] },
    });
  });

  test("rejects prerender = false in the paths op too", async () => {
    const response = await call({
      protocol: ISOLATE_PROTOCOL_VERSION,
      op: "paths",
      routes: [{ file: ON_DEMAND, route: routeOf(ON_DEMAND) }],
    });
    expect(response).toMatchObject({ status: "error" });
  });

  test("reports a malformed request as an error payload", async () => {
    const request = new Request("http://pletivo.invalid/render", { method: "POST", body: "{}" });
    const response = await createIsolateEntry(PROGRAM).fetch(request, {});
    expect(parseIsolateResponse(await response.json())).toMatchObject({ status: "error" });
  });

  test("reads a null param as undefined, in both ops", async () => {
    expect(await pathsOf([{ params: { page: null } }])).toEqual({
      protocol: ISOLATE_PROTOCOL_VERSION,
      status: "paths",
      paths: { [PAGED]: [[["page", null]]] },
    });
    const pages = program({
      [PAGED]: { default: pageText, getStaticPaths: () => [{ params: { page: null }, props: { n: 7 } }] },
    });
    const response = await callWith(pages, renderRequest(PAGED, [["page", null]], routeOf(PAGED)));
    expect(response).toMatchObject({ status: "rendered", html: "<p>n=7 page=undefined has=true</p>" });
  });

  test("rejects a getStaticPaths result that is not an array", async () => {
    expect(errorMessage(await pathsOf({ params: {} }))).toBe(
      `${PAGED}: getStaticPaths() must return an array`,
    );
  });

  test("rejects a getStaticPaths entry without a params object", async () => {
    expect(errorMessage(await pathsOf([{ params: { page: "1" } }, { props: {} }]))).toBe(
      `${PAGED}: getStaticPaths() entry 1 has no params object`,
    );
  });

  test("rejects a param that is neither a string nor null", async () => {
    expect(errorMessage(await pathsOf([{ params: { page: 2 } }]))).toBe(
      `${PAGED}: getStaticPaths() param "page" must be a string`,
    );
  });

  test("installs astro:env values before the page runs", async () => {
    const events: unknown[] = [];
    const entryProgram: IsolateProgram = {
      ...program({
        [INDEX]: {
          default: () => {
            events.push("page");
            return "<p></p>";
          },
        },
      }),
      envInstallers: [(values) => events.push(values)],
    };
    await callWith(entryProgram, renderRequest(INDEX, [], null), {
      PLETIVO_ENV: { client: { A: "1" }, server: { B: "2" } },
    });
    expect(events).toEqual([{ client: { A: "1" }, server: { B: "2" } }, "page"]);
  });

  test("installs import.meta.env before the page runs, and only when the program reads it", async () => {
    const readEnv = () => JSON.stringify(Reflect.get(globalThis, "__pletivoImportMetaEnv") ?? null);
    Reflect.deleteProperty(globalThis, "__pletivoImportMetaEnv");
    const pages = program({ [INDEX]: { default: () => readEnv() } });
    const env = { PLETIVO_IMPORT_META_ENV: { SITE: "https://example.com" } };
    try {
      expect(await callWith(pages, renderRequest(INDEX, [], null), env)).toMatchObject({ html: "null" });
      const reading = { ...pages, importMetaEnv: true };
      expect(await callWith(reading, renderRequest(INDEX, [], null), env)).toMatchObject({
        html: '{"SITE":"https://example.com"}',
      });
      expect(await callWith(reading, renderRequest(INDEX, [], null), {})).toMatchObject({ html: "{}" });
    } finally {
      Reflect.deleteProperty(globalThis, "__pletivoImportMetaEnv");
    }
  });

  test("resolves content paths as file-map keys", () => {
    expect(resolveFrom("", "./content/product")).toBe("content/product");
    expect(resolveFrom("src/content", "../assets/a.png")).toBe("src/assets/a.png");
  });
});

describe("isolate entry content scope", () => {
  const POSTS = "src/pages/posts.tsx";
  const sources: Record<string, Record<string, string>> = {
    first: { "content/posts/a.md": "---\ntitle: One\n---\n" },
    second: { "content/posts/a.md": "---\ntitle: Two\n---\n" },
  };
  const refs: string[] = [];
  const binding: ContentBinding = {
    scan(ref, dir) {
      refs.push(ref);
      return Object.keys(sources[ref] ?? {})
        .filter((file) => file.startsWith(`${dir}/`))
        .map((file) => ({ entry: file.slice(dir.length + 1), path: file }));
    },
    read(ref, path) {
      return sources[ref]?.[path] ?? null;
    },
  };
  const contentProgram: IsolateProgram = {
    ...program({
      [POSTS]: {
        default: async () => {
          const posts = await collections.getCollection("posts");
          return posts.map((post) => String(post.data.title)).join(",");
        },
      },
    }),
    content: { collections, images },
    contentConfig: async () => ({
      collections: {
        posts: collections.defineCollection({
          loader: collections.glob({ pattern: "*.md", base: "content/posts" }),
          schema: collections.z.object({ title: collections.z.string() }),
        }),
      },
    }),
  };

  function contentRequest(contentRef: string | undefined): IsolateRequest {
    const request = renderRequest(POSTS, [], null);
    return contentRef === undefined ? request : { ...request, contentRef, rootDir: "" };
  }

  test("reads each request's own sources through a fresh runtime", async () => {
    refs.length = 0;
    const env = { PLETIVO_CONTENT: binding };
    expect(await callWith(contentProgram, contentRequest("first"), env)).toMatchObject({ html: "One" });
    expect(await callWith(contentProgram, contentRequest("second"), env)).toMatchObject({ html: "Two" });
    expect(refs).toEqual(["first", "second"]);
  });

  test("closes the scope when the request ends", async () => {
    await callWith(contentProgram, contentRequest("first"), { PLETIVO_CONTENT: binding });
    await expect(collections.getCollection("posts")).rejects.toThrow("no active runtime");
  });

  test("names a request without a content ref", async () => {
    const response = await callWith(contentProgram, contentRequest(undefined), { PLETIVO_CONTENT: binding });
    expect(errorMessage(response)).toBe("[pletivo-workers] the render request carries no content ref");
  });

  test("names a missing content binding", async () => {
    expect(errorMessage(await callWith(contentProgram, contentRequest("first"), {}))).toBe(
      "[pletivo-workers] the render isolate has no content binding",
    );
  });
});
