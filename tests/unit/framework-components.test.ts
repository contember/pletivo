import { describe, expect, test } from "bun:test";
import { jsx } from "@pletivo/runtime/jsx-runtime";
import { createComponent, renderAstroPage, renderComponent } from "@pletivo/runtime/astro-shim";
import { createHtml } from "@pletivo/runtime/html-string";

/**
 * Bun's file loader makes an import of a file it has no module for (`.svelte`,
 * `.vue`, …) evaluate to the file's path. Rendered as a tag, that path was a
 * wrong page with no error.
 */
const SVELTE_FILE = "/project/src/components/Counter.svelte";

function astroPageRendering(tag: string) {
  return createComponent(async (result) => {
    const rendered = await renderComponent(result, "Counter", tag, {}, {});
    return createHtml(`<main>${rendered.__html}</main>`);
  }, "page");
}

describe("an imported file in a component position", () => {
  test("fails a .astro render by framework and file", async () => {
    await expect(renderAstroPage(astroPageRendering(SVELTE_FILE), {})).rejects.toThrow(
      `pletivo cannot render Svelte components: ${SVELTE_FILE}`,
    );
  });

  test("fails a JSX render by framework and file", () => {
    expect(() => jsx("/project/src/components/Counter.vue", {})).toThrow(
      "pletivo cannot render Vue components: /project/src/components/Counter.vue",
    );
  });

  test("fails for a file of no known framework too", () => {
    expect(() => jsx("C:\\project\\src\\Widget.marko", {})).toThrow(
      "pletivo cannot render C:\\project\\src\\Widget.marko as a component",
    );
  });

  test("leaves element names alone", async () => {
    expect(await renderAstroPage(astroPageRendering("custom-element"), {})).toBe(
      "<main><custom-element></custom-element></main>",
    );
    const input = jsx("input", { type: "text" });
    expect(input instanceof Promise ? await input : input).toEqual(createHtml('<input type="text">'));
  });
});
