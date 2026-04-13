import { describe, test, expect } from "bun:test";
import { resolveI18nConfig } from "../../packages/pletivo/src/i18n/config";
import {
  getPathByLocale,
  getLocaleByPath,
  getRelativeLocaleUrl,
  getAbsoluteLocaleUrl,
  getRelativeLocaleUrlList,
  getAbsoluteLocaleUrlList,
  fallbackChain,
} from "../../packages/pletivo/src/i18n/helpers";

const cfgSimple = resolveI18nConfig({
  defaultLocale: "en",
  locales: ["en", "pt", "it"],
})!;

const cfgAlias = resolveI18nConfig({
  defaultLocale: "en",
  locales: [
    "en",
    "pt",
    { path: "spanish", codes: ["es", "es-SP"] },
  ],
})!;

const cfgPrefixAlways = resolveI18nConfig({
  defaultLocale: "en",
  locales: ["en", "pt"],
  routing: { prefixDefaultLocale: true },
})!;

describe("getPathByLocale", () => {
  test("returns the code for plain string locale", () => {
    expect(getPathByLocale(cfgSimple, "en")).toBe("en");
    expect(getPathByLocale(cfgSimple, "pt")).toBe("pt");
  });

  test("returns the path alias for aliased locale", () => {
    expect(getPathByLocale(cfgAlias, "es")).toBe("spanish");
    expect(getPathByLocale(cfgAlias, "es-SP")).toBe("spanish");
  });

  test("accepts the path itself as input", () => {
    expect(getPathByLocale(cfgAlias, "spanish")).toBe("spanish");
  });

  test("throws on unknown locale", () => {
    expect(() => getPathByLocale(cfgSimple, "de")).toThrow(/unknown locale/);
  });
});

describe("getLocaleByPath", () => {
  test("returns the canonical code for a known path", () => {
    expect(getLocaleByPath(cfgAlias, "spanish")).toBe("es");
    expect(getLocaleByPath(cfgAlias, "en")).toBe("en");
  });

  test("throws on unknown path", () => {
    expect(() => getLocaleByPath(cfgAlias, "german")).toThrow(/unknown path/);
  });

  test("does NOT accept a code in place of a path", () => {
    // Astro's semantics — path lookup is strict.
    expect(() => getLocaleByPath(cfgAlias, "es")).toThrow();
  });
});

describe("getRelativeLocaleUrl", () => {
  test("non-default locale gets prefixed", () => {
    expect(getRelativeLocaleUrl(cfgSimple, "/", "pt", "about")).toBe("/pt/about");
    expect(getRelativeLocaleUrl(cfgSimple, "/", "it", "about")).toBe("/it/about");
  });

  test("default locale is NOT prefixed when prefixDefaultLocale is false", () => {
    expect(getRelativeLocaleUrl(cfgSimple, "/", "en", "about")).toBe("/about");
  });

  test("default locale IS prefixed when prefixDefaultLocale is true", () => {
    expect(getRelativeLocaleUrl(cfgPrefixAlways, "/", "en", "about")).toBe("/en/about");
  });

  test("uses path alias instead of code", () => {
    expect(getRelativeLocaleUrl(cfgAlias, "/", "es", "about")).toBe("/spanish/about");
    expect(getRelativeLocaleUrl(cfgAlias, "/", "es-SP", "about")).toBe("/spanish/about");
  });

  test("accepts empty path (locale index)", () => {
    expect(getRelativeLocaleUrl(cfgSimple, "/", "pt")).toBe("/pt");
    expect(getRelativeLocaleUrl(cfgSimple, "/", "en")).toBe("/");
  });

  test("base path is prepended", () => {
    expect(getRelativeLocaleUrl(cfgSimple, "/new-site", "pt", "about"))
      .toBe("/new-site/pt/about");
    expect(getRelativeLocaleUrl(cfgSimple, "/new-site", "en", "about"))
      .toBe("/new-site/about");
  });

  test("strips leading slash from path input", () => {
    expect(getRelativeLocaleUrl(cfgSimple, "/", "pt", "/about")).toBe("/pt/about");
  });

  test("throws on unknown locale", () => {
    expect(() => getRelativeLocaleUrl(cfgSimple, "/", "fr", "about")).toThrow();
  });
});

describe("getAbsoluteLocaleUrl", () => {
  test("prepends site origin", () => {
    expect(
      getAbsoluteLocaleUrl(cfgSimple, "/", "https://example.com", "pt", "about"),
    ).toBe("https://example.com/pt/about");
  });

  test("handles site with trailing slash", () => {
    expect(
      getAbsoluteLocaleUrl(cfgSimple, "/", "https://example.com/", "pt", "about"),
    ).toBe("https://example.com/pt/about");
  });

  test("falls back to relative URL when site is undefined", () => {
    expect(getAbsoluteLocaleUrl(cfgSimple, "/", undefined, "pt", "about"))
      .toBe("/pt/about");
  });
});

describe("getRelativeLocaleUrlList", () => {
  test("returns one URL per configured locale", () => {
    const list = getRelativeLocaleUrlList(cfgSimple, "/", "about");
    expect(list).toEqual(["/about", "/pt/about", "/it/about"]);
  });

  test("respects path aliases across the list", () => {
    const list = getRelativeLocaleUrlList(cfgAlias, "/", "about");
    expect(list).toEqual(["/about", "/pt/about", "/spanish/about"]);
  });
});

describe("getAbsoluteLocaleUrlList", () => {
  test("prepends site origin to each entry", () => {
    const list = getAbsoluteLocaleUrlList(
      cfgSimple,
      "/",
      "https://example.com",
      "about",
    );
    expect(list).toEqual([
      "https://example.com/about",
      "https://example.com/pt/about",
      "https://example.com/it/about",
    ]);
  });
});

describe("fallbackChain", () => {
  test("returns a singleton when no fallback is defined", () => {
    expect(fallbackChain(cfgSimple, "pt")).toEqual(["pt"]);
  });

  test("walks the chain to the end", () => {
    const cfg = resolveI18nConfig({
      defaultLocale: "en",
      locales: ["en", "pt", "it"],
      fallback: { it: "pt", pt: "en" },
    })!;
    expect(fallbackChain(cfg, "it")).toEqual(["it", "pt", "en"]);
  });

  test("breaks cycles", () => {
    const cfg = resolveI18nConfig({
      defaultLocale: "en",
      locales: ["en", "pt"],
      fallback: { pt: "en" },
    })!;
    // Hand-insert a cycle to confirm the guard
    (cfg.fallback as Record<string, string>).en = "pt";
    expect(fallbackChain(cfg, "pt")).toEqual(["pt", "en"]);
  });
});
