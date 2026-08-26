import { afterEach, describe, expect, test } from "bun:test";
import { setBase, getBase, withBase, stripBase } from "@pletivo/runtime/base";

afterEach(() => setBase("/"));

describe("base path module", () => {
  describe("setBase normalization", () => {
    test("empty/undefined/null/`/` → `/`", () => {
      setBase(undefined);
      expect(getBase()).toBe("/");
      setBase("");
      expect(getBase()).toBe("/");
      setBase("/");
      expect(getBase()).toBe("/");
    });

    test("strips trailing slashes", () => {
      setBase("/my-app/");
      expect(getBase()).toBe("/my-app");
      setBase("/my-app///");
      expect(getBase()).toBe("/my-app");
    });

    test("adds leading slash if missing", () => {
      setBase("my-app");
      expect(getBase()).toBe("/my-app");
    });
  });

  describe("withBase", () => {
    test("under root base, returns input unchanged", () => {
      setBase("/");
      expect(withBase("/foo.js")).toBe("/foo.js");
      expect(withBase("/_astro/x.js")).toBe("/_astro/x.js");
    });

    test("prefixes the configured base", () => {
      setBase("/my-app");
      expect(withBase("/foo.js")).toBe("/my-app/foo.js");
      expect(withBase("/_astro/x.js")).toBe("/my-app/_astro/x.js");
    });
  });

  describe("stripBase", () => {
    test("under root base, returns pathname unchanged", () => {
      setBase("/");
      expect(stripBase("/foo")).toBe("/foo");
      expect(stripBase("/")).toBe("/");
    });

    test("strips the configured prefix", () => {
      setBase("/my-app");
      expect(stripBase("/my-app/foo")).toBe("/foo");
      expect(stripBase("/my-app/_astro/x.js")).toBe("/_astro/x.js");
    });

    test("returns null when prefix doesn't match", () => {
      setBase("/my-app");
      expect(stripBase("/other/foo")).toBeNull();
      expect(stripBase("/my-appsuffix")).toBeNull(); // not /my-app/...
    });

    test("base root path matches as `/`", () => {
      setBase("/my-app");
      expect(stripBase("/my-app")).toBe("/");
    });
  });

  describe("withBase + stripBase round trip", () => {
    test("paths survive a round trip under arbitrary base", () => {
      setBase("/sub-app");
      for (const p of ["/", "/foo", "/_astro/hoisted-abc.js", "/__styles.css"]) {
        expect(stripBase(withBase(p))).toBe(p);
      }
    });
  });
});
