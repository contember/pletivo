import { describe, test, expect } from "bun:test";
import { resolveI18nConfig } from "../../packages/pletivo/src/i18n/config";

describe("resolveI18nConfig", () => {
  test("returns null when i18n is undefined", () => {
    expect(resolveI18nConfig(undefined)).toBeNull();
  });

  test("returns null when defaultLocale or locales missing", () => {
    expect(resolveI18nConfig({ defaultLocale: "en" } as never)).toBeNull();
    expect(resolveI18nConfig({ locales: ["en"] } as never)).toBeNull();
  });

  test("normalizes bare string locales", () => {
    const cfg = resolveI18nConfig({
      defaultLocale: "en",
      locales: ["en", "pt"],
    })!;
    expect(cfg.locales).toEqual([
      { code: "en", path: "en", codes: ["en"] },
      { code: "pt", path: "pt", codes: ["pt"] },
    ]);
    expect(cfg.defaultLocale.code).toBe("en");
  });

  test("normalizes object locales with path + codes", () => {
    const cfg = resolveI18nConfig({
      defaultLocale: "spanish",
      locales: [
        "en",
        "pt",
        { path: "spanish", codes: ["es", "es-SP"] },
      ],
    })!;
    const spanish = cfg.locales.find((l) => l.path === "spanish")!;
    expect(spanish.code).toBe("es");
    expect(spanish.codes).toEqual(["es", "es-SP"]);
    expect(spanish.path).toBe("spanish");
  });

  test("resolves defaultLocale by path alias", () => {
    const cfg = resolveI18nConfig({
      defaultLocale: "spanish",
      locales: [{ path: "spanish", codes: ["es"] }, "en"],
    })!;
    expect(cfg.defaultLocale.code).toBe("es");
  });

  test("resolves defaultLocale by any code in codes array", () => {
    const cfg = resolveI18nConfig({
      defaultLocale: "es-SP",
      locales: [{ path: "spanish", codes: ["es", "es-SP"] }],
    })!;
    expect(cfg.defaultLocale.code).toBe("es");
    expect(cfg.defaultLocale.path).toBe("spanish");
  });

  test("throws when defaultLocale is unknown", () => {
    expect(() =>
      resolveI18nConfig({
        defaultLocale: "fr",
        locales: ["en", "pt"],
      }),
    ).toThrow(/defaultLocale/);
  });

  test("throws when locale object has empty codes", () => {
    expect(() =>
      resolveI18nConfig({
        defaultLocale: "en",
        locales: ["en", { path: "spanish", codes: [] }],
      }),
    ).toThrow(/must have at least one code/);
  });

  test("builds byCode lookup map", () => {
    const cfg = resolveI18nConfig({
      defaultLocale: "en",
      locales: ["en", { path: "spanish", codes: ["es", "es-SP"] }],
    })!;
    expect(cfg.byCode.get("en")?.code).toBe("en");
    expect(cfg.byCode.get("es")?.path).toBe("spanish");
    expect(cfg.byCode.get("es-SP")?.code).toBe("es");
    expect(cfg.byCode.get("de")).toBeUndefined();
  });

  test("builds byPath lookup map", () => {
    const cfg = resolveI18nConfig({
      defaultLocale: "en",
      locales: ["en", { path: "spanish", codes: ["es"] }],
    })!;
    expect(cfg.byPath.get("en")?.code).toBe("en");
    expect(cfg.byPath.get("spanish")?.code).toBe("es");
    expect(cfg.byPath.get("es")).toBeUndefined();
  });

  test("routing defaults: prefixDefault=false, redirect=true, fallback=rewrite", () => {
    const cfg = resolveI18nConfig({
      defaultLocale: "en",
      locales: ["en"],
    })!;
    expect(cfg.routing.prefixDefaultLocale).toBe(false);
    expect(cfg.routing.redirectToDefaultLocale).toBe(true);
    expect(cfg.routing.fallbackType).toBe("rewrite");
  });

  test("routing prefixDefaultLocale true", () => {
    const cfg = resolveI18nConfig({
      defaultLocale: "en",
      locales: ["en"],
      routing: { prefixDefaultLocale: true },
    })!;
    expect(cfg.routing.prefixDefaultLocale).toBe(true);
  });

  test("routing redirectToDefaultLocale false", () => {
    const cfg = resolveI18nConfig({
      defaultLocale: "en",
      locales: ["en"],
      routing: { prefixDefaultLocale: true, redirectToDefaultLocale: false },
    })!;
    expect(cfg.routing.redirectToDefaultLocale).toBe(false);
  });

  test("routing fallbackType redirect", () => {
    const cfg = resolveI18nConfig({
      defaultLocale: "en",
      locales: ["en"],
      routing: { fallbackType: "redirect" },
    })!;
    expect(cfg.routing.fallbackType).toBe("redirect");
  });

  test("fallback map is normalized to canonical codes", () => {
    const cfg = resolveI18nConfig({
      defaultLocale: "en",
      locales: [
        "en",
        "pt",
        "it",
        { path: "spanish", codes: ["es", "es-AR"] },
      ],
      fallback: {
        it: "en",
        pt: "en",
        spanish: "en",
      },
    })!;
    expect(cfg.fallback).toEqual({
      it: "en",
      pt: "en",
      es: "en",
    });
  });

  test("fallback entries referencing unknown locales are dropped", () => {
    const cfg = resolveI18nConfig({
      defaultLocale: "en",
      locales: ["en", "pt"],
      fallback: { it: "en", pt: "fr" },
    })!;
    expect(cfg.fallback).toEqual({});
  });
});
