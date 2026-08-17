import { describe, test, expect, beforeEach } from "bun:test";
import { renderComponent } from "../../packages/pletivo/src/runtime/astro-shim";
import { resetIslandRegistry, getUsedIslands } from "../../packages/pletivo/src/runtime/island";

// The .astro compat path compiles `<Counter client:visible />` to a
// renderComponent(result, "Counter", Counter, { "client:visible": true,
// "client:component-hydration": "visible", ... }) call. renderComponent must turn
// that into a hydration marker (and register the island for bundling) the same way
// the native JSX runtime does — otherwise islands used from .astro files ship as
// dead static HTML. The `result` arg is unused on the island path.
const result = {} as never;

function Counter(props: Record<string, unknown>) {
  return { __html: `<button>${props.initial ?? 0}</button>` };
}

describe("renderComponent — .astro island hydration (client:*)", () => {
  beforeEach(() => resetIslandRegistry());

  test("client:visible wraps the component in a pletivo-island marker + registers it", async () => {
    const out = await renderComponent(
      result,
      "Counter",
      Counter,
      { initial: 5, "client:visible": true, "client:component-hydration": "visible" },
      {},
    );
    const html = (out as { __html: string }).__html;
    expect(html).toContain("<pletivo-island");
    expect(html).toContain('data-component="Counter"');
    expect(html).toContain('data-hydrate="visible"');
    expect(html).toContain("<button>5</button>"); // SSR'd inner HTML
    expect(getUsedIslands().get("Counter")).toBe("Counter"); // registered for the build to bundle
  });

  test("no client directive → rendered inline, no island marker, not registered", async () => {
    const out = await renderComponent(result, "Counter", Counter, { initial: 1 }, {});
    const html = (out as { __html: string }).__html;
    expect(html).not.toContain("pletivo-island");
    expect(html).toContain("<button>1</button>");
    expect(getUsedIslands().size).toBe(0);
  });

  test("client:only skips SSR (empty shell) but still hydrates (as load)", async () => {
    const out = await renderComponent(
      result,
      "Counter",
      Counter,
      { "client:only": true, "client:component-hydration": "only" },
      {},
    );
    const html = (out as { __html: string }).__html;
    expect(html).toContain('data-component="Counter"');
    expect(html).toContain('data-hydrate="load"'); // only → load
    expect(html).not.toContain("<button>"); // no server render
  });

  test("client:* directives are stripped from the serialized island props", async () => {
    const out = await renderComponent(
      result,
      "Counter",
      Counter,
      { initial: 2, "client:visible": true, "client:component-hydration": "visible" },
      {},
    );
    const html = (out as { __html: string }).__html;
    const m = html.match(/data-props='([^']*)'/);
    expect(m).toBeTruthy();
    expect(m![1]).not.toContain("client:");
    expect(m![1]).toContain("initial");
  });
});
