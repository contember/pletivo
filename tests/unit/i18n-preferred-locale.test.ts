import { describe, test, expect } from "bun:test";
import { resolveI18nConfig } from "../../packages/pletivo/src/i18n/config";
import { parsePreferredLocales } from "../../packages/pletivo/src/i18n/helpers";

const cfg = resolveI18nConfig({
  defaultLocale: "en",
  locales: ["en", "pt", "it"],
})!;

const cfgWithAlias = resolveI18nConfig({
  defaultLocale: "en",
  locales: [
    "en",
    "pt",
    { path: "spanish", codes: ["es", "es-AR"] },
  ],
})!;

describe("parsePreferredLocales", () => {
  test("missing header returns undefined + empty list", () => {
    expect(parsePreferredLocales(cfg, null)).toEqual({
      preferredLocale: undefined,
      preferredLocaleList: [],
    });
    expect(parsePreferredLocales(cfg, undefined)).toEqual({
      preferredLocale: undefined,
      preferredLocaleList: [],
    });
    expect(parsePreferredLocales(cfg, "")).toEqual({
      preferredLocale: undefined,
      preferredLocaleList: [],
    });
  });

  test("single tag maps to its canonical code", () => {
    expect(parsePreferredLocales(cfg, "pt").preferredLocale).toBe("pt");
  });

  test("language-prefix match: fr-CA → fr if configured", () => {
    const localCfg = resolveI18nConfig({
      defaultLocale: "en",
      locales: ["en", "fr"],
    })!;
    expect(parsePreferredLocales(localCfg, "fr-CA").preferredLocale).toBe("fr");
  });

  test("exact code wins over prefix fallback", () => {
    const localCfg = resolveI18nConfig({
      defaultLocale: "en",
      locales: ["en", "fr", "fr-CA"],
    })!;
    expect(parsePreferredLocales(localCfg, "fr-CA").preferredLocale).toBe("fr-CA");
  });

  test("ordered by quality value", () => {
    const res = parsePreferredLocales(
      cfg,
      "it;q=0.5,pt;q=0.9,en;q=1",
    );
    expect(res.preferredLocale).toBe("en");
    expect(res.preferredLocaleList).toEqual(["en", "pt", "it"]);
  });

  test("preserves original order on equal quality", () => {
    const res = parsePreferredLocales(cfg, "pt,it,en");
    expect(res.preferredLocaleList).toEqual(["pt", "it", "en"]);
  });

  test("drops unknown tags silently", () => {
    const res = parsePreferredLocales(cfg, "de,ja,pt");
    expect(res.preferredLocale).toBe("pt");
    expect(res.preferredLocaleList).toEqual(["pt"]);
  });

  test("deduplicates tags that match the same locale", () => {
    const res = parsePreferredLocales(cfgWithAlias, "es,es-AR,pt");
    // Both "es" and "es-AR" resolve to canonical "es"
    expect(res.preferredLocaleList).toEqual(["es", "pt"]);
  });

  test("handles whitespace and q params robustly", () => {
    const res = parsePreferredLocales(cfg, "  pt ; q=0.9 ,  en ; q=0.1  ");
    expect(res.preferredLocale).toBe("pt");
    expect(res.preferredLocaleList).toEqual(["pt", "en"]);
  });

  test("matches case-insensitively", () => {
    const res = parsePreferredLocales(cfg, "PT-BR,EN");
    expect(res.preferredLocale).toBe("pt");
  });

  test("skips malformed entries", () => {
    const res = parsePreferredLocales(cfg, ",,pt,,");
    expect(res.preferredLocale).toBe("pt");
  });

  test("q=0 entries still appear in the list (Astro parity)", () => {
    // Astro doesn't drop q=0 explicitly — we match its behavior since
    // the list is just ordered matching.
    const res = parsePreferredLocales(cfg, "en;q=1,pt;q=0");
    expect(res.preferredLocaleList).toEqual(["en", "pt"]);
  });
});
