import { describe, expect, test } from "bun:test";
import { minifyInlinedStyle, type InlinedStyle } from "./inlined-style.ts";

const page = (css: string, { head = "", body = "<p>x</p>" } = {}) =>
  `<!DOCTYPE html><html lang="en"> <head><title>T</title>${head}<style>${css}</style>\n</head> <body>${body}</body></html>`;

/** What `pletivo build` inlines: its sheet, already minified. */
const BUILT = ".a{color:#010203}.b{margin:0}\n";
/** What this host inlines for the same two rules: labelled per file, as written. */
const RENDERED = "/* a.css */\n.a { color: rgb(1, 2, 3); }\n\n\n/* b.css */\n.b { margin: 0; }\n";

function minified(result: InlinedStyle): { expected: string; actual: string } {
  if (result.kind !== "minified") throw new Error(`expected a minified comparison, got ${result.kind}`);
  return result;
}

describe("inlined head <style> parity", () => {
  test("the same rules written two ways compare equal", async () => {
    const { expected, actual } = minified(await minifyInlinedStyle(page(BUILT), page(RENDERED)));
    expect(actual).toBe(expected);
  });

  test("a sheet missing one rule does not", async () => {
    const result = await minifyInlinedStyle(page(BUILT), page("/* a.css */\n.a { color: rgb(1, 2, 3); }\n"));
    const { expected, actual } = minified(result);
    expect(actual).not.toBe(expected);
  });

  test("a different declaration does not", async () => {
    const result = await minifyInlinedStyle(page(BUILT), page(RENDERED.replace("margin: 0", "margin: 1px")));
    const { expected, actual } = minified(result);
    expect(actual).not.toBe(expected);
  });

  test("reordered rules do not", async () => {
    const { expected, actual } = minified(await minifyInlinedStyle(page(".a{color:red}.b{color:blue}"), page(".b { color: blue }\n.a { color: red }\n")));
    expect(actual).not.toBe(expected);
  });

  test("a mid-sheet @import on one side is named as the minifier's refusal", async () => {
    const result = await minifyInlinedStyle(page(BUILT), page(`${RENDERED}@import "./c.css";\n.c { color: red; }\n`));
    if (result.kind !== "rejected") throw new Error(`expected a rejected comparison, got ${result.kind}`);
    expect(result.side).toBe("this host");
    expect(result.log).toContain("@import");
  });

  test("every byte outside the <style> is still compared", async () => {
    const result = await minifyInlinedStyle(page(BUILT), page(RENDERED, { body: "<p>y</p>" }));
    const { expected, actual } = minified(result);
    expect(actual).not.toBe(expected);
  });

  test("an identical inline block in front is skipped for the first pair that differs", async () => {
    const head = "<style>body{margin:0}</style>";
    const { expected, actual } = minified(await minifyInlinedStyle(page(BUILT, { head }), page(RENDERED, { head })));
    expect(actual).toBe(expected);
  });

  test("a head <style> on the build's side only is left to the byte comparison", async () => {
    const withoutStyle = `<!DOCTYPE html><html lang="en"> <head><title>T</title>\n</head> <body><p>x</p></body></html>`;
    expect((await minifyInlinedStyle(page(BUILT), withoutStyle)).kind).toBe("none");
  });

  test("the same text on both sides is left to the byte comparison", async () => {
    expect((await minifyInlinedStyle(page(RENDERED), page(RENDERED))).kind).toBe("none");
  });

  test("a page whose build inlined nothing in the head is left alone", async () => {
    const built = `<html><head><title>T</title></head><body><style>.s{color:red}</style></body></html>`;
    expect((await minifyInlinedStyle(built, built)).kind).toBe("none");
  });
});
