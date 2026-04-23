import { describe, test, expect } from "bun:test";
import { createComponent, renderAstroPage } from "../../packages/pletivo/src/runtime/astro-shim";

async function getSlotResult(slotHtml: string): Promise<string> {
  let captured = "";
  const Page = createComponent(async (result) => {
    const Astro = result.createAstro({}, {
      default: () => ({ __html: slotHtml }),
    });
    captured = await Astro.slots.render("default");
    return { __html: "" };
  }, "page");
  await renderAstroPage(Page, {}, {});
  return captured;
}

describe("Astro.slots.render()", () => {
  test("coerces to raw HTML for regex.test / String() / templates", async () => {
    // Regression: @nuasite/components form does submitButtonRegex.test(slotContent);
    // previously coerced to "[object Object]".
    const slot = await getSlotResult("<button>Submit</button>");
    expect(/<button[^>]*>/i.test(slot)).toBe(true);
    expect(String(slot)).toBe("<button>Submit</button>");
    expect(`${slot}`).toBe("<button>Submit</button>");
  });

  test("exposes String.prototype methods (includes, replace, length, indexOf)", async () => {
    const slot = await getSlotResult("<button type='submit'>Go</button>");
    expect(slot.includes("<button")).toBe(true);
    expect(slot.indexOf("Go")).toBe(22);
    expect(slot.length).toBe(33);
    expect(slot.replace("Go", "Send")).toBe("<button type='submit'>Send</button>");
  });

  test("round-trip interpolation is not double-escaped", async () => {
    const Page = createComponent(async (result) => {
      const Astro = result.createAstro({}, {
        default: () => ({ __html: "<p>hi & bye</p>" }),
      });
      const rendered = await Astro.slots.render("default");
      return { __html: String(rendered) };
    }, "page");

    const html = await renderAstroPage(Page, {}, {});
    expect(html).toBe("<p>hi & bye</p>");
  });

  test("result is still detected as HtmlString (structural __html check)", async () => {
    const slot = await getSlotResult("<span/>") as unknown as { __html: string };
    expect(slot.__html).toBe("<span/>");
    expect("__html" in slot).toBe(true);
  });
});
