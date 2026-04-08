import { describe, test, expect, beforeEach } from "bun:test";
import {
  resetIslandRegistry,
  getUsedIslands,
  registerIsland,
  renderIslandWrapper,
} from "../../packages/pavouk/src/runtime/island";

describe("island registry", () => {
  beforeEach(() => {
    resetIslandRegistry();
  });

  test("starts empty", () => {
    expect(getUsedIslands().size).toBe(0);
  });

  test("registerIsland adds entry", () => {
    registerIsland("Counter", "Counter.tsx");
    const islands = getUsedIslands();
    expect(islands.get("Counter")).toBe("Counter.tsx");
  });

  test("multiple registrations", () => {
    registerIsland("Counter", "Counter.tsx");
    registerIsland("Gallery", "Gallery.tsx");
    const islands = getUsedIslands();
    expect(islands.size).toBe(2);
  });

  test("resetIslandRegistry clears all", () => {
    registerIsland("Counter", "Counter.tsx");
    registerIsland("Gallery", "Gallery.tsx");
    resetIslandRegistry();
    expect(getUsedIslands().size).toBe(0);
  });

  test("getUsedIslands returns a copy", () => {
    registerIsland("Counter", "Counter.tsx");
    const copy = getUsedIslands();
    resetIslandRegistry();
    // Original copy should still have the entry
    expect(copy.size).toBe(1);
    expect(getUsedIslands().size).toBe(0);
  });

  test("overwriting same name", () => {
    registerIsland("Counter", "old.tsx");
    registerIsland("Counter", "new.tsx");
    expect(getUsedIslands().get("Counter")).toBe("new.tsx");
    expect(getUsedIslands().size).toBe(1);
  });
});

describe("renderIslandWrapper", () => {
  test("renders basic wrapper", () => {
    const html = renderIslandWrapper("Counter", "load", { initial: 0 }, "<button>0</button>");
    expect(html).toContain("<pavouk-island");
    expect(html).toContain('data-component="Counter"');
    expect(html).toContain('data-hydrate="load"');
    expect(html).toContain("<button>0</button>");
    expect(html).toContain("</pavouk-island>");
  });

  test("serializes props as JSON", () => {
    const html = renderIslandWrapper("Widget", "idle", { count: 5, label: "hello" }, "");
    expect(html).toContain('"count":5');
    expect(html).toContain('"label":"hello"');
  });

  test("escapes props for HTML safety", () => {
    const html = renderIslandWrapper("Widget", "load", { text: "a<b&c'd" }, "");
    // Should escape < & '
    expect(html).toContain("&lt;");
    expect(html).toContain("&amp;");
    expect(html).toContain("&#39;");
  });

  test("empty inner HTML", () => {
    const html = renderIslandWrapper("Empty", "visible", {}, "");
    expect(html).toContain("<pavouk-island");
    expect(html).toContain("></pavouk-island>");
  });

  test("media hydration strategy", () => {
    const html = renderIslandWrapper("Sidebar", "media(min-width: 1024px)", {}, "<aside>x</aside>");
    expect(html).toContain('data-hydrate="media(min-width: 1024px)"');
  });
});
