import { describe, test, expect } from "bun:test";
import {
  createComponent,
  renderAstroPage,
  type AstroGlobal,
} from "../../packages/pletivo/src/runtime/astro-shim";

/**
 * End-to-end plumbing test: build a minimal Astro-compiler-shaped
 * component, render it with a `__pageContext` carrying locale fields,
 * and assert the fields propagate all the way into the AstroGlobal that
 * reaches the component body. This pins the contract between
 * dev.ts / build.ts (which fill pageContext) and .astro templates that
 * read `Astro.currentLocale`.
 */
describe("AstroGlobal locale plumbing", () => {
  function makeCapture() {
    const holder: { captured?: AstroGlobal } = {};
    const factory = createComponent(
      (result, props, slots) => {
        holder.captured = result.createAstro(props, slots);
        return { __html: "" };
      },
      "test-component",
    );
    return { holder, factory };
  }

  test("currentLocale propagates from pageContext", async () => {
    const { holder, factory } = makeCapture();
    await renderAstroPage(factory, {}, { currentLocale: "pt" });
    expect(holder.captured?.currentLocale).toBe("pt");
  });

  test("preferredLocale propagates from pageContext", async () => {
    const { holder, factory } = makeCapture();
    await renderAstroPage(factory, {}, {
      currentLocale: "en",
      preferredLocale: "pt",
      preferredLocaleList: ["pt", "it", "en"],
    });
    expect(holder.captured?.preferredLocale).toBe("pt");
    expect(holder.captured?.preferredLocaleList).toEqual(["pt", "it", "en"]);
  });

  test("missing locale fields become undefined + empty list", async () => {
    const { holder, factory } = makeCapture();
    await renderAstroPage(factory, {}, {});
    expect(holder.captured?.currentLocale).toBeUndefined();
    expect(holder.captured?.preferredLocale).toBeUndefined();
    expect(holder.captured?.preferredLocaleList).toEqual([]);
  });

  test("url, params, site still work alongside locale fields", async () => {
    const { holder, factory } = makeCapture();
    await renderAstroPage(factory, {}, {
      url: new URL("http://example.com/pt/blog"),
      params: { slug: "hello" },
      site: new URL("http://example.com/"),
      currentLocale: "pt",
    });
    expect(holder.captured?.url?.pathname).toBe("/pt/blog");
    expect(holder.captured?.params).toEqual({ slug: "hello" });
    expect(holder.captured?.site?.origin).toBe("http://example.com");
    expect(holder.captured?.currentLocale).toBe("pt");
  });
});
