import { describe, expect, test } from "bun:test";
import { minifyInlinedStyle } from "./inlined-style.ts";

const page = (css: string, body = "<p>x</p>") =>
  `<!DOCTYPE html><html lang="en"> <head><title>T</title><style>${css}</style>\n</head> <body>${body}</body></html>`;

/** What `pletivo build` inlines: its sheet, already minified. */
const BUILT = ".a{color:#010203}.b{margin:0}\n";
/** What this host inlines for the same two rules: labelled per file, as written. */
const RENDERED = "/* a.css */\n.a { color: rgb(1, 2, 3); }\n\n\n/* b.css */\n.b { margin: 0; }\n";

describe("inlined head <style> parity", () => {
  test("the same rules written two ways compare equal", async () => {
    const result = await minifyInlinedStyle(page(BUILT), page(RENDERED));
    if (result.kind !== "minified") throw new Error(`expected a minified comparison, got ${result.kind}`);
    expect(result.actual).toBe(result.expected);
    expect(result.built).toEqual({ bytes: 30, blocks: 2, minifiedBytes: 30, minifiedBlocks: 2 });
    expect(result.rendered.minifiedBlocks).toBe(2);
  });

  test("a sheet missing one rule does not", async () => {
    const result = await minifyInlinedStyle(page(BUILT), page("/* a.css */\n.a { color: rgb(1, 2, 3); }\n"));
    if (result.kind !== "minified") throw new Error(`expected a minified comparison, got ${result.kind}`);
    expect(result.actual).not.toBe(result.expected);
    expect(result.rendered.minifiedBlocks).toBe(1);
  });

  test("a different declaration does not", async () => {
    const result = await minifyInlinedStyle(page(BUILT), page(RENDERED.replace("margin: 0", "margin: 1px")));
    if (result.kind !== "minified") throw new Error(`expected a minified comparison, got ${result.kind}`);
    expect(result.actual).not.toBe(result.expected);
  });

  test("every byte outside the <style> is still compared", async () => {
    const result = await minifyInlinedStyle(page(BUILT), page(RENDERED, "<p>y</p>"));
    if (result.kind !== "minified") throw new Error(`expected a minified comparison, got ${result.kind}`);
    expect(result.actual).not.toBe(result.expected);
  });

  test("a head <style> on the build's side only is reported", async () => {
    const withoutStyle = `<!DOCTYPE html><html lang="en"> <head><title>T</title>\n</head> <body></body></html>`;
    expect((await minifyInlinedStyle(page(BUILT), withoutStyle)).kind).toBe("missing");
  });

  test("the same text on both sides is left to the byte comparison", async () => {
    expect((await minifyInlinedStyle(page(RENDERED), page(RENDERED))).kind).toBe("none");
  });

  test("a page whose build inlined nothing in the head is left alone", async () => {
    const built = `<html><head><title>T</title></head><body><style>.s{color:red}</style></body></html>`;
    expect((await minifyInlinedStyle(built, built)).kind).toBe("none");
  });
});
