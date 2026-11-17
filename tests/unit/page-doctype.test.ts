import { describe, expect, test } from "bun:test";
import { pageDoctype } from "@pletivo/core/page-doctype";

const COMPRESSED = { compressHTML: true, partial: false };
const UNCOMPRESSED = { compressHTML: false, partial: false };
const NATIVE = { compressHTML: undefined, partial: false };

describe("pageDoctype, an Astro project", () => {
  test("adds the doctype without a newline under compressHTML", () => {
    expect(pageDoctype("<html><body>x</body></html>", COMPRESSED)).toBe("<!DOCTYPE html>");
  });

  test("adds a newline after it without compressHTML", () => {
    expect(pageDoctype("<html><body>x</body></html>", UNCOMPRESSED)).toBe("<!DOCTYPE html>\n");
  });

  test("prefixes a page that has no <html>", () => {
    expect(pageDoctype("<style>h1{color:red}</style><h1>x</h1>", COMPRESSED)).toBe("<!DOCTYPE html>");
    expect(pageDoctype("<p>x</p>", UNCOMPRESSED)).toBe("<!DOCTYPE html>\n");
    expect(pageDoctype("plain text", COMPRESSED)).toBe("<!DOCTYPE html>");
  });

  test("keeps a doctype the page already has, in any case", () => {
    for (const html of ["<!doctype html><html></html>", "<!DOCTYPE HTML><html></html>", "<!DocType html>\n<p>x</p>"]) {
      expect(pageDoctype(html, COMPRESSED)).toBe("");
      expect(pageDoctype(html, UNCOMPRESSED)).toBe("");
    }
  });

  test("finds the doctype after leading whitespace and comments", () => {
    expect(pageDoctype("\n  <!doctype html><html></html>", COMPRESSED)).toBe("");
    expect(pageDoctype("<!-- built -->\n<!DOCTYPE html><html></html>", COMPRESSED)).toBe("");
  });

  test("prefixes a page whose leading whitespace comes before <html>", () => {
    expect(pageDoctype("\n  <html></html>", COMPRESSED)).toBe("<!DOCTYPE html>");
  });

  test("gives a partial none", () => {
    expect(pageDoctype("<p>x</p>", { compressHTML: true, partial: true })).toBe("");
    expect(pageDoctype("<html></html>", { compressHTML: false, partial: true })).toBe("");
  });

  test("does not take a doctype later in the page for the page's own", () => {
    expect(pageDoctype("<p>x</p><pre><!doctype html></pre>", COMPRESSED)).toBe("<!DOCTYPE html>");
  });
});

describe("pageDoctype, a pletivo-native project", () => {
  test("adds the doctype and a newline only to a page starting with <html", () => {
    expect(pageDoctype("<html><body>x</body></html>", NATIVE)).toBe("<!DOCTYPE html>\n");
    expect(pageDoctype("\n  <html lang=\"en\"></html>", NATIVE)).toBe("<!DOCTYPE html>\n");
  });

  test("ignores partial, as before", () => {
    expect(pageDoctype("<html></html>", { compressHTML: undefined, partial: true })).toBe("<!DOCTYPE html>\n");
  });

  test("leaves every other page alone", () => {
    expect(pageDoctype("<p>x</p>", NATIVE)).toBe("");
    expect(pageDoctype("<!DOCTYPE html><html></html>", NATIVE)).toBe("");
    expect(pageDoctype("<!doctype html><html></html>", NATIVE)).toBe("");
  });
});
