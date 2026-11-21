import { describe, expect, test } from "bun:test";
import { render, unescapeHTML } from "@pletivo/runtime/astro-shim";

function* spans(prefix: string) {
  for (const n of [1, 2]) yield `<span>${prefix}${n}</span>`;
}

async function* asyncSpans() {
  for (const span of spans("a")) yield Promise.resolve(span);
}

const html = async (value: unknown) => (await unescapeHTML(value)).__html;

describe("set:html values, as Astro's unescapeHTML takes them", () => {
  test("a Response's body, bytes and a stream are HTML", async () => {
    expect(await html(new Response("<b>body</b>"))).toBe("<b>body</b>");
    expect(await html(new TextEncoder().encode("<i>bytes</i>"))).toBe("<i>bytes</i>");
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue("<u>");
        controller.enqueue(new TextEncoder().encode("read</u>"));
        controller.close();
      },
    });
    expect(await html(stream)).toBe("<u>read</u>");
  });

  test("false, null and undefined are nothing; true and numbers their text", async () => {
    expect(await Promise.all([false, null, undefined, true, 0, 1].map(html))).toEqual(["", "", "", "true", "0", "1"]);
  });

  test("each chunk of an iterable or an async iterable is HTML", async () => {
    expect(await html(spans("i"))).toBe("<span>i1</span><span>i2</span>");
    expect(await html(asyncSpans())).toBe("<span>a1</span><span>a2</span>");
  });
});

describe("template expressions, as Astro's renderChild takes them", () => {
  test("a falsy value other than 0 renders nothing; true renders its text", async () => {
    const out = await render`${true}|${false}|${null}|${undefined}|${""}|${NaN}|${0}`;
    expect(out.__html).toBe("true||||||0");
  });

  test("a Response renders nothing; an iterable's chunks are escaped text", async () => {
    const out = await render`<p>${new Response("x", { status: 302 })}</p><p>${spans("i")}</p><p>${asyncSpans()}</p>`;
    expect(out.__html).toBe(
      "<p></p><p>&lt;span&gt;i1&lt;/span&gt;&lt;span&gt;i2&lt;/span&gt;</p><p>&lt;span&gt;a1&lt;/span&gt;&lt;span&gt;a2&lt;/span&gt;</p>",
    );
  });
});
