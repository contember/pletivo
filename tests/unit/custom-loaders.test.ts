import { describe, test, expect, beforeEach } from "bun:test";
import {
  defineCollection,
  initCollections,
  getCollection,
  getEntry,
  runWithBunContentRuntime,
} from "../../packages/pletivo/src/content/collection";
import type {
  AstroLoader,
  FunctionLoader,
  LoaderContext,
} from "../../packages/pletivo/src/content/collection";
import { z } from "zod";
import path from "path";

const fixtureRoot = path.join(import.meta.dir, "../fixture-custom-loaders");

// ── Helpers ──

/** Install the collections read by the fixture's stable content.config.ts. */
function installCollections(collections: Record<string, ReturnType<typeof defineCollection>>) {
  Reflect.set(globalThis, "__testCollections", collections);
}

describe("function loader", () => {
  beforeEach(async () => {
    const loader: FunctionLoader = async () => [
      { id: "post-1", title: "Hello World", tags: ["intro"] },
      { id: "post-2", title: "Second Post", tags: ["update"] },
    ];

    installCollections({
      articles: defineCollection({
        loader,
        schema: z.object({
          title: z.string(),
          tags: z.array(z.string()).optional(),
        }),
      }),
    });
    await runWithBunContentRuntime(() => initCollections(fixtureRoot));
  });

  test("loads entries from function loader", async () => {
    const entries = await runWithBunContentRuntime(() => getCollection("articles"));
    expect(entries.length).toBe(2);
  });

  test("entries have correct IDs", async () => {
    const entries = await runWithBunContentRuntime(() => getCollection("articles"));
    const ids = entries.map((e) => e.id).sort();
    expect(ids).toEqual(["post-1", "post-2"]);
  });

  test("entry data is validated against schema", async () => {
    const entry = await runWithBunContentRuntime(() => getEntry("articles", "post-1"));
    expect(entry).toBeDefined();
    expect(entry!.data.title).toBe("Hello World");
    expect(entry!.data.tags).toEqual(["intro"]);
  });

  test("render returns empty html for non-markdown entries", async () => {
    const entry = await runWithBunContentRuntime(() => getEntry("articles", "post-1"));
    const { html } = await entry!.render();
    expect(html).toBe("");
  });
});

describe("Astro Content Layer loader", () => {
  beforeEach(async () => {
    const loader: AstroLoader = {
      name: "test-cms-loader",
      async load(context: LoaderContext) {
        // Simulate a CMS API fetch
        const posts = [
          { id: "cms-1", title: "CMS Post One", category: "news" },
          { id: "cms-2", title: "CMS Post Two", category: "blog" },
          { id: "cms-3", title: "CMS Post Three", category: "news" },
        ];

        for (const post of posts) {
          const { id, ...data } = post;
          // Validate via parseData
          const validated = await context.parseData({ id, data });
          context.store.set({ id, data: validated });
        }

        // Use meta store
        context.meta.set("lastSync", Date.now());
      },
    };

    installCollections({
      cms: defineCollection({
        loader,
        schema: z.object({
          title: z.string(),
          category: z.string(),
        }),
      }),
    });
    await runWithBunContentRuntime(() => initCollections(fixtureRoot));
  });

  test("loads entries from Astro Content Layer loader", async () => {
    const entries = await runWithBunContentRuntime(() => getCollection("cms"));
    expect(entries.length).toBe(3);
  });

  test("entries are validated against schema", async () => {
    const entry = await runWithBunContentRuntime(() => getEntry("cms", "cms-1"));
    expect(entry).toBeDefined();
    expect(entry!.data.title).toBe("CMS Post One");
    expect(entry!.data.category).toBe("news");
  });

  test("filtering works on Astro loader entries", async () => {
    const news = await runWithBunContentRuntime(() =>
      getCollection<{ title: string; category: string }>(
        "cms",
        (entry) => entry.data.category === "news",
      ),
    );
    expect(news.length).toBe(2);
  });
});

describe("Astro loader with rendered content", () => {
  beforeEach(async () => {
    const loader: AstroLoader = {
      name: "test-rendered-loader",
      async load(context) {
        context.store.set({
          id: "page-1",
          data: { title: "Pre-rendered Page" },
          body: "# Hello",
          rendered: { html: "<h1>Hello</h1>" },
        });
      },
    };

    installCollections({
      pages: defineCollection({
        loader,
        schema: z.object({ title: z.string() }),
      }),
    });
    await runWithBunContentRuntime(() => initCollections(fixtureRoot));
  });

  test("rendered content is available via render()", async () => {
    const entry = await runWithBunContentRuntime(() => getEntry("pages", "page-1"));
    expect(entry).toBeDefined();
    const { html } = await entry!.render();
    expect(html).toBe("<h1>Hello</h1>");
  });

  test("body is preserved", async () => {
    const entry = await runWithBunContentRuntime(() => getEntry("pages", "page-1"));
    expect(entry!.body).toBe("# Hello");
  });
});

describe("Astro loader parseData validation errors", () => {
  beforeEach(async () => {
    const loader: AstroLoader = {
      name: "test-strict-loader",
      async load(context) {
        // This entry has valid data
        const valid = await context.parseData({
          id: "good",
          data: { title: "Valid", count: 5 },
        });
        context.store.set({ id: "good", data: valid });

        // This entry has invalid data — parseData throws
        try {
          await context.parseData({
            id: "bad",
            data: { title: 123, count: "not-a-number" },
          });
          context.store.set({ id: "bad", data: { title: 123 } });
        } catch {
          // Loader handles the error — skips the entry
        }
      },
    };

    installCollections({
      strict: defineCollection({
        loader,
        schema: z.object({
          title: z.string(),
          count: z.number(),
        }),
      }),
    });
    await runWithBunContentRuntime(() => initCollections(fixtureRoot));
  });

  test("only valid entries are stored when loader handles errors", async () => {
    const entries = await runWithBunContentRuntime(() => getCollection("strict"));
    expect(entries.length).toBe(1);
    expect(entries[0].id).toBe("good");
    expect(entries[0].data.title).toBe("Valid");
  });
});
