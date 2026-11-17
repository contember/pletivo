import { describe, expect, test } from "bun:test";
import { stylesheetsForPage, type CssBundle, type Stylesheet } from "../../packages/pletivo/src/css";

const shared: Stylesheet = { type: "external", href: "/_astro/shared.css" };
const a: Stylesheet = { type: "inline", content: ".a{}" };
const b: Stylesheet = { type: "external", href: "/_astro/b.css" };
const bundle: CssBundle = {
  shared,
  groups: [
    { sheet: a, pages: new Set(["/p/one.astro"]) },
    { sheet: b, pages: new Set(["/p/two.astro"]) },
  ],
  knownPages: new Set(["/p/one.astro", "/p/two.astro"]),
};

describe("stylesheetsForPage", () => {
  test("a page with known reach gets the shared sheet and its own groups", () => {
    expect(stylesheetsForPage(bundle, "/p/one.astro")).toEqual([shared, a]);
  });

  test("a page whose reach is unknown gets every group, in order, rather than losing CSS", () => {
    expect(stylesheetsForPage(bundle, "/p/cached.astro")).toEqual([shared, a, b]);
    expect(stylesheetsForPage(bundle, undefined)).toEqual([shared, a, b]);
  });
});
