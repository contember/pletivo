/**
 * `.mdx` compiled by pletivo's MDX plugin hands a hydrated component the island metadata
 * `@astrojs/mdx` adds (`rehypeAnalyzeAstroMetadata`). The compiled module runs against a
 * recording JSX runtime, so each assertion is on the props a component call receives.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import path from "path";
import { compileMdx, configureMdx } from "../../packages/pletivo/src/mdx-plugin";
import { calls, type RecordedCall } from "../fixture-mdx-islands/recording-jsx-runtime";

const fixtureDir = path.join(import.meta.dir, "../fixture-mdx-islands");
const recordingRuntimePath = path.join(fixtureDir, "recording-jsx-runtime.ts");
const pletivoRuntimePath = path.resolve(import.meta.dir, "../../packages/pletivo/src/runtime/jsx-runtime.ts");

let dir: string;

beforeAll(() => {
  // A copy at a fresh path, so the asserted absolute paths come from the `.mdx` file's location.
  dir = mkdtempSync(path.join(import.meta.dir, "tmp-mdx-islands-"));
  cpSync(path.join(fixtureDir, "src"), path.join(dir, "src"), { recursive: true });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function pagePath(page: string): string {
  return path.join(dir, "src/pages", page);
}

function componentPath(file: string): string {
  return path.join(dir, "src/components", file);
}

async function compilePage(page: string): Promise<string> {
  const file = pagePath(page);
  return compileMdx(await Bun.file(file).text(), file);
}

async function renderPage(page: string): Promise<RecordedCall[]> {
  const code = await compilePage(page);
  expect(code).toContain(pletivoRuntimePath);
  const compiled = pagePath(page.replace(/\.mdx$/, ".compiled.mjs"));
  writeFileSync(compiled, code.replaceAll(pletivoRuntimePath, recordingRuntimePath));
  const mod = await import(compiled);
  calls.length = 0;
  mod.default({});
  return [...calls];
}

function callWithId(recorded: RecordedCall[], id: string): RecordedCall {
  const call = recorded.find((c) => c.props.id === id);
  if (!call) throw new Error(`no component call with id ${id}`);
  return call;
}

describe("island metadata on MDX component calls", () => {
  let recorded: RecordedCall[];

  beforeAll(async () => {
    recorded = await renderPage("islands.mdx");
  });

  test("default import", () => {
    expect(callWithId(recorded, "default")).toEqual({
      component: "Counter",
      props: {
        id: "default",
        "client:load": true,
        count: 1,
        "client:component-path": componentPath("Counter.jsx"),
        "client:component-export": "default",
        "client:component-hydration": true,
      },
    });
  });

  test("named import", () => {
    expect(callWithId(recorded, "named").props).toEqual({
      id: "named",
      "client:idle": true,
      "client:component-path": componentPath("ui.jsx"),
      "client:component-export": "Toggle",
      "client:component-hydration": true,
    });
  });

  test("renamed import exports the imported name, not the local one", () => {
    expect(callWithId(recorded, "renamed").props).toEqual({
      id: "renamed",
      "client:media": "(max-width: 600px)",
      "client:component-path": componentPath("ui.jsx"),
      "client:component-export": "Toggle",
      "client:component-hydration": true,
    });
  });

  test("namespace member exports the member name", () => {
    expect(callWithId(recorded, "namespace").props).toEqual({
      id: "namespace",
      "client:visible": true,
      "client:component-path": componentPath("ui.jsx"),
      "client:component-export": "Counter",
      "client:component-hydration": true,
    });
  });

  test("client:only also carries the display name", () => {
    expect(callWithId(recorded, "only")).toEqual({
      component: "Counter",
      props: {
        id: "only",
        "client:only": "preact",
        "client:display-name": "Counter",
        "client:component-path": componentPath("Counter.jsx"),
        "client:component-export": "default",
        "client:component-hydration": true,
      },
    });
  });

  test("a `.jsx` import that exists only as `.tsx` resolves to the `.tsx` file", () => {
    expect(callWithId(recorded, "tsx-fallback").props["client:component-path"]).toBe(componentPath("Widget.tsx"));
  });

  test("an element inside a paragraph", () => {
    expect(callWithId(recorded, "inline").props["client:component-export"]).toBe("Toggle");
  });

  test("a component without a directive gets no props", () => {
    expect(callWithId(recorded, "static").props).toEqual({ id: "static", count: 2 });
  });
});

describe("member and namespace edge cases", () => {
  let recorded: RecordedCall[];

  beforeAll(async () => {
    recorded = await renderPage("edge-cases.mdx");
  });

  test("a member of a default import exports `default.<member>`", () => {
    expect(callWithId(recorded, "default-member").props).toEqual({
      id: "default-member",
      "client:load": true,
      "client:component-path": componentPath("ns-default.jsx"),
      "client:component-export": "default.Component",
      "client:component-hydration": true,
    });
  });

  test("a member of a named import exports the tag as written", () => {
    expect(callWithId(recorded, "named-member").props).toEqual({
      id: "named-member",
      "client:load": true,
      "client:component-path": componentPath("ns-named.jsx"),
      "client:component-export": "ns.Component",
      "client:component-hydration": true,
    });
  });

  test("a bare namespace element exports an empty name", () => {
    expect(callWithId(recorded, "bare-namespace").props).toEqual({
      id: "bare-namespace",
      "client:load": true,
      "client:component-path": componentPath("ui.jsx"),
      "client:component-export": "",
      "client:component-hydration": true,
    });
  });

  test("client:only overrides a written client:component-path, as Astro does", () => {
    expect(callWithId(recorded, "only-written-path").props["client:component-path"]).toBe(componentPath("Counter.jsx"));
  });
});

describe("plugin order", () => {
  test("an element a user rehype plugin injects gets the metadata", async () => {
    const injectCounter = () => (tree: { children: unknown[] }) => {
      tree.children.push({
        type: "mdxJsxFlowElement",
        name: "Counter",
        attributes: [
          { type: "mdxJsxAttribute", name: "id", value: "injected" },
          { type: "mdxJsxAttribute", name: "client:load", value: null },
        ],
        children: [],
      });
    };
    configureMdx({ rehypePlugins: [injectCounter] });
    try {
      const recorded = await renderPage("injected.mdx");
      expect(callWithId(recorded, "injected").props).toEqual({
        id: "injected",
        "client:load": true,
        "client:component-path": componentPath("Counter.jsx"),
        "client:component-export": "default",
        "client:component-hydration": true,
      });
    } finally {
      configureMdx({});
    }
  });
});

describe("with-mdx page shape", () => {
  // Astro's build of with-mdx gives this island uid `1wfHfx`: its shorthash covers the
  // component path, and it matches only with the import's `.jsx` extension kept.
  test("Counter.jsx keeps the extension the import has", async () => {
    const recorded = await renderPage("with-mdx.mdx");
    const counter = recorded.find((c) => c.component === "Counter");
    expect(counter?.props).toEqual({
      "client:idle": true,
      "client:component-path": componentPath("Counter.jsx"),
      "client:component-export": "default",
      "client:component-hydration": true,
    });
  });
});

describe("compile errors and warnings", () => {
  test("a hydrated component without a matching import fails the compile", async () => {
    await expect(compilePage("missing-import.mdx")).rejects.toThrow(
      "Could not render `Ghost`. No matching import has been found for `Ghost`.",
    );
  });

  test("a client directive on an .astro component warns", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await compilePage("astro-directive.mdx");
      expect(warn).toHaveBeenCalledWith(
        "You are attempting to render <Note client:load />, but Note is an Astro component. Astro components do not render in the client and should not have a hydration directive. Please use a framework component for client rendering.",
      );
    } finally {
      warn.mockRestore();
    }
  });
});
