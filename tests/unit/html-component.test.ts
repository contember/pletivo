import { describe, expect, test } from "bun:test";
import { createHtml } from "@pletivo/runtime/html-string";
import { htmlComponent } from "@pletivo/runtime/astro-shim";
import { htmlComponentParts } from "../../packages/pletivo/src/html-plugin";

describe("htmlComponentParts, as Astro's rehypeSlots splits an .html file", () => {
  test("text stays verbatim, template-literal characters and braces included", async () => {
    const source = '<div data-x="`${a}`">{Astro.generator} \\` ${b}</div>\n<script>const s = `<slot></slot> ${c}`;</script>\n';
    expect(await htmlComponentParts(source)).toEqual([source]);
  });

  test("a slot falls back to its trimmed children, or to itself when empty; is:inline stays text", async () => {
    expect(await htmlComponentParts('<p>ž<slot name="x">  fall <b>é</b> </slot>ř<slot></slot><slot is:inline></slot></p>')).toEqual([
      "<p>ž",
      { slot: "x", fallback: "fall <b>é</b>" },
      "ř",
      { slot: "default", fallback: "<slot></slot>" },
      "<slot is:inline></slot></p>",
    ]);
  });
});

describe("htmlComponent", () => {
  test("renders the slots passed and the fallbacks of the others, ignoring props", async () => {
    const Component = htmlComponent(["<a>", { slot: "default", fallback: "none" }, "</a><b>", { slot: "b", fallback: "B" }, "</b>"]);
    const html = await Component({ title: "ignored" });
    expect(html.__html).toBe("<a>none</a><b>B</b>");
    const filled = await Component({ createAstro: () => ({}) }, {}, { default: () => createHtml("<i>in</i>") });
    expect(filled.__html).toBe("<a><i>in</i></a><b>B</b>");
  });
});
