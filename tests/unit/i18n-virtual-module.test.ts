import { describe, test, expect, beforeEach } from "bun:test";
import { resolveI18nConfig } from "../../packages/pletivo/src/i18n/config";
import {
  setI18nRuntimeState,
  __resetI18nRuntimeState,
  getPathByLocale,
  getLocaleByPath,
  getRelativeLocaleUrl,
  getAbsoluteLocaleUrl,
  getRelativeLocaleUrlList,
  getAbsoluteLocaleUrlList,
  middleware,
  redirectToDefaultLocale,
  redirectToFallback,
  notFound,
} from "../../packages/pletivo/src/i18n/virtual-module";

describe("astro:i18n virtual module", () => {
  beforeEach(() => {
    __resetI18nRuntimeState();
  });

  test("throws before setI18nRuntimeState is called", () => {
    expect(() => getPathByLocale("en")).toThrow(/i18n is not configured/);
    expect(() => getLocaleByPath("en")).toThrow(/i18n is not configured/);
    expect(() => getRelativeLocaleUrl("en", "about")).toThrow(
      /i18n is not configured/,
    );
  });

  test("becomes functional after setI18nRuntimeState with config", () => {
    const cfg = resolveI18nConfig({
      defaultLocale: "en",
      locales: ["en", "pt", { path: "spanish", codes: ["es", "es-SP"] }],
    })!;
    setI18nRuntimeState(cfg, "/", undefined);

    expect(getPathByLocale("es")).toBe("spanish");
    expect(getPathByLocale("pt")).toBe("pt");
    expect(getLocaleByPath("spanish")).toBe("es");
    expect(getRelativeLocaleUrl("pt", "about")).toBe("/pt/about");
    expect(getRelativeLocaleUrl("en", "about")).toBe("/about");
    expect(getRelativeLocaleUrl("es", "about")).toBe("/spanish/about");
  });

  test("absolute URLs use the configured site", () => {
    const cfg = resolveI18nConfig({
      defaultLocale: "en",
      locales: ["en", "pt"],
    })!;
    setI18nRuntimeState(cfg, "/", "https://example.com");
    expect(getAbsoluteLocaleUrl("pt", "about")).toBe(
      "https://example.com/pt/about",
    );
  });

  test("base path is honored in relative URLs", () => {
    const cfg = resolveI18nConfig({
      defaultLocale: "en",
      locales: ["en", "pt"],
    })!;
    setI18nRuntimeState(cfg, "/new-site", undefined);
    expect(getRelativeLocaleUrl("pt", "about")).toBe("/new-site/pt/about");
  });

  test("list helpers enumerate every configured locale", () => {
    const cfg = resolveI18nConfig({
      defaultLocale: "en",
      locales: ["en", "pt", "it"],
    })!;
    setI18nRuntimeState(cfg, "/", "https://example.com");
    expect(getRelativeLocaleUrlList("about")).toEqual([
      "/about",
      "/pt/about",
      "/it/about",
    ]);
    expect(getAbsoluteLocaleUrlList("about")).toEqual([
      "https://example.com/about",
      "https://example.com/pt/about",
      "https://example.com/it/about",
    ]);
  });

  test("setI18nRuntimeState(null, ...) disables helpers again", () => {
    const cfg = resolveI18nConfig({
      defaultLocale: "en",
      locales: ["en", "pt"],
    })!;
    setI18nRuntimeState(cfg, "/", undefined);
    expect(getPathByLocale("pt")).toBe("pt");
    setI18nRuntimeState(null, "/", undefined);
    expect(() => getPathByLocale("pt")).toThrow();
  });

  test("SSR-only helpers throw with a helpful message", () => {
    const cfg = resolveI18nConfig({
      defaultLocale: "en",
      locales: ["en"],
    })!;
    setI18nRuntimeState(cfg, "/", undefined);
    expect(() => redirectToDefaultLocale()).toThrow(/static-site output/);
    expect(() => redirectToFallback()).toThrow(/static-site output/);
    expect(() => notFound()).toThrow(/static-site output/);
  });

  test("middleware factory returns a passthrough function", async () => {
    const mw = middleware();
    const next = async () => "next-result";
    const result = await mw({}, next);
    expect(result).toBe("next-result");
  });
});
