import { describe, test, expect } from "bun:test";
import {
  createComponent,
  render,
  renderAstroPage,
} from "@pletivo/runtime/astro-shim";
import { createHtml, type HtmlString } from "@pletivo/runtime/html-string";

function deferredValue<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let settle: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return {
    promise,
    resolve(value) {
      if (!settle) throw new Error("Deferred promise was not initialized.");
      settle(value);
    },
  };
}

function slotText(value: unknown): string {
  return typeof value === "object" && value !== null
    ? String(Reflect.get(value, "text"))
    : "";
}

async function getSlotResult(slotHtml: string): Promise<HtmlString> {
  let captured = createHtml("");
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
    expect(Reflect.apply(RegExp.prototype.test, /<button[^>]*>/i, [slot])).toBe(true);
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
    const slot = await getSlotResult("<span/>");
    expect(slot.__html).toBe("<span/>");
    expect("__html" in slot).toBe(true);
  });

  test("passes arguments into functions inside compiled slot templates", async () => {
    let captured = createHtml("");
    const Page = createComponent(async (result) => {
      const Astro = result.createAstro({}, {
        before: () => render`<div>${({ content }: { content: string }) =>
          createHtml(`<span>${content}</span>`)}</div>`,
      });
      captured = await Astro.slots.render("before", [{ content: "value" }]);
      return createHtml("");
    }, "compiled-slot");

    await renderAstroPage(Page, {}, {});
    expect(String(captured)).toBe("<span>value</span>");
  });

  test("keeps parallel slot arguments lexical across an awaited value", async () => {
    const leftValue = deferredValue<unknown>();
    const rightValue = deferredValue<unknown>();
    let captured: string[] = [];
    const Page = createComponent(async (result) => {
      const Astro = result.createAstro({}, {
        left: () => leftValue.promise,
        right: () => rightValue.promise,
      });
      const left = Astro.slots.render("left", [{ text: "left" }]);
      const right = Astro.slots.render("right", [{ text: "right" }]);

      leftValue.resolve((props: unknown) => ({ __html: `<span>${slotText(props)}</span>` }));
      captured.push(String(await left));
      rightValue.resolve((props: unknown) => ({ __html: `<span>${slotText(props)}</span>` }));
      captured.push(String(await right));
      return { __html: "" };
    }, "parallel-slots");

    await renderAstroPage(Page, {}, {});
    expect(captured).toEqual(["left", "right"]);
  });

  test("keeps outer slot arguments across a nested slot render", async () => {
    let captured = "";
    const Page = createComponent(async (result) => {
      let Astro = result.createAstro({}, {});
      Astro = result.createAstro({}, {
        inner: () => (props: unknown) => ({ __html: `<i>${slotText(props)}</i>` }),
        outer: () => async (props: unknown) => {
          const inner = await Astro.slots.render("inner", [{ text: "inner" }]);
          return { __html: `<span>${slotText(props)}:${inner}</span>` };
        },
      });
      captured = String(await Astro.slots.render("outer", [{ text: "outer" }]));
      return { __html: "" };
    }, "nested-slots");

    await renderAstroPage(Page, {}, {});
    expect(captured).toBe("outer:inner");
  });
});
