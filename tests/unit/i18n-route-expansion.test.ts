import { describe, test, expect } from "bun:test";
import { parseRoute } from "../../packages/pletivo/src/router";
import { resolveI18nConfig } from "../../packages/pletivo/src/i18n/config";
import { detectRouteLocale } from "../../packages/pletivo/src/i18n/route-expansion";
import { buildAstroRoutes } from "../../packages/pletivo/src/astro-host/routes-adapter";
import type { AstroConfig } from "../../packages/pletivo/src/astro-host/types";

const i18nSimple = {
  defaultLocale: "en",
  locales: ["en", "pt", "it"],
};

const i18nAlias = {
  defaultLocale: "en",
  locales: [
    "en",
    "pt",
    { path: "spanish", codes: ["es", "es-SP"] },
  ],
};

const i18nPrefixAlways = {
  defaultLocale: "en",
  locales: ["en", "pt"],
  routing: { prefixDefaultLocale: true },
};

describe("detectRouteLocale", () => {
  test("root file → default locale when prefixDefault=false", () => {
    const cfg = resolveI18nConfig(i18nSimple)!;
    const r = parseRoute("about.astro");
    const d = detectRouteLocale(r, cfg);
    expect(d.locale?.code).toBe("en");
    expect(d.hasLocaleInPath).toBe(false);
  });

  test("root file → null locale when prefixDefault=true", () => {
    const cfg = resolveI18nConfig(i18nPrefixAlways)!;
    const r = parseRoute("404.astro");
    const d = detectRouteLocale(r, cfg);
    expect(d.locale).toBeNull();
  });

  test("file under known locale dir → that locale", () => {
    const cfg = resolveI18nConfig(i18nSimple)!;
    const r = parseRoute("pt/about.astro");
    const d = detectRouteLocale(r, cfg);
    expect(d.locale?.code).toBe("pt");
    expect(d.hasLocaleInPath).toBe(true);
  });

  test("file under aliased locale dir uses path not code", () => {
    const cfg = resolveI18nConfig(i18nAlias)!;
    const rSpanish = parseRoute("spanish/about.astro");
    const rEs = parseRoute("es/about.astro");
    expect(detectRouteLocale(rSpanish, cfg).locale?.code).toBe("es");
    // The bare code is NOT a valid source directory
    expect(detectRouteLocale(rEs, cfg).locale?.code).toBe("en");
  });

  test("default locale subdir still detected when prefixDefault=true", () => {
    const cfg = resolveI18nConfig(i18nPrefixAlways)!;
    const r = parseRoute("en/about.astro");
    expect(detectRouteLocale(r, cfg).locale?.code).toBe("en");
  });

  test("dynamic route under locale dir keeps locale", () => {
    const cfg = resolveI18nConfig(i18nSimple)!;
    const r = parseRoute("pt/blog/[slug].astro");
    expect(detectRouteLocale(r, cfg).locale?.code).toBe("pt");
  });
});

describe("buildAstroRoutes with i18n", () => {
  const baseConfig: AstroConfig = {
    root: new URL("file:///project/"),
    srcDir: new URL("file:///project/src/"),
    publicDir: new URL("file:///project/public/"),
    outDir: new URL("file:///project/dist/"),
    base: "/",
    trailingSlash: "ignore",
    build: {
      format: "directory",
      client: new URL("file:///project/dist/client/"),
      server: new URL("file:///project/dist/server/"),
      assets: "_astro",
    },
    integrations: [],
    vite: {},
    redirects: {},
  };

  test("tags non-localized route when i18n is absent", () => {
    const routes = buildAstroRoutes(
      [{ route: parseRoute("about.astro") }],
      { ...baseConfig },
    );
    expect(routes).toHaveLength(1);
    expect(routes[0]!.pathname).toBe("about");
    expect(routes[0]!.locale).toBeUndefined();
  });

  test("root file tagged with default locale under prefixDefault=false", () => {
    const routes = buildAstroRoutes(
      [{ route: parseRoute("about.astro") }],
      { ...baseConfig, i18n: i18nSimple },
    );
    expect(routes[0]!.locale).toBe("en");
    expect(routes[0]!.pathname).toBe("about");
  });

  test("locale-subdir file tagged with its locale", () => {
    const routes = buildAstroRoutes(
      [
        { route: parseRoute("pt/about.astro") },
        { route: parseRoute("it/about.astro") },
      ],
      { ...baseConfig, i18n: i18nSimple },
    );
    expect(routes[0]!.locale).toBe("pt");
    expect(routes[0]!.pathname).toBe("pt/about");
    expect(routes[1]!.locale).toBe("it");
    expect(routes[1]!.pathname).toBe("it/about");
  });

  test("aliased locale source directory maps to canonical code", () => {
    const routes = buildAstroRoutes(
      [{ route: parseRoute("spanish/about.astro") }],
      { ...baseConfig, i18n: i18nAlias },
    );
    expect(routes[0]!.locale).toBe("es");
    expect(routes[0]!.pathname).toBe("spanish/about");
  });

  test("root file without locale dir under prefixDefault=true is untagged", () => {
    const routes = buildAstroRoutes(
      [{ route: parseRoute("404.astro") }],
      { ...baseConfig, i18n: i18nPrefixAlways },
    );
    expect(routes[0]!.locale).toBeUndefined();
  });

  test("dynamic route under locale dir expands with locale tag", () => {
    const routes = buildAstroRoutes(
      [
        {
          route: parseRoute("pt/blog/[slug].astro"),
          staticPaths: [
            { params: { slug: "hello" } },
            { params: { slug: "world" } },
          ],
        },
      ],
      { ...baseConfig, i18n: i18nSimple },
    );
    expect(routes).toHaveLength(2);
    for (const r of routes) {
      expect(r.locale).toBe("pt");
      expect(r.pathname.startsWith("pt/blog/")).toBe(true);
    }
  });
});
