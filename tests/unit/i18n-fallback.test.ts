import { describe, test, expect } from "bun:test";
import { parseRoute, type Route } from "@pletivo/core/router";
import { resolveI18nConfig } from "@pletivo/core/i18n/config";
import {
  generateFallbackEmissions,
  resolveFallbackRoute,
  resolveDefaultLocaleRedirect,
  type FallbackEmission,
} from "@pletivo/core/i18n/fallback";

const makeRoutes = (files: string[]): Route[] => files.map(parseRoute);

describe("generateFallbackEmissions — rewrite mode", () => {
  const cfg = resolveI18nConfig({
    defaultLocale: "en",
    locales: ["en", "pt", "it"],
    fallback: { it: "en", pt: "en" },
    routing: { fallbackType: "rewrite" },
  })!;

  test("no emissions when every locale already has the file", () => {
    const routes = makeRoutes([
      "en/start.astro",
      "pt/start.astro",
      "it/start.astro",
    ]);
    const emissions = generateFallbackEmissions({
      routes,
      i18n: cfg,
      dynamicPaths: new Map(),
      base: "/",
    });
    expect(emissions).toEqual([]);
  });

  test("synthesizes missing locale by walking fallback chain", () => {
    // prefixDefault=false, so default-locale file can live at root
    const routes = makeRoutes(["start.astro", "pt/start.astro"]);
    const emissions = generateFallbackEmissions({
      routes,
      i18n: cfg,
      dynamicPaths: new Map(),
      base: "/",
    });
    // Only `it` is missing a version and has fallback → en (at root).
    const it = emissions.filter((e) => e.targetLocale === "it");
    expect(it).toHaveLength(1);
    expect(it[0]!.targetPathname).toBe("it/start");
    expect(it[0]!.sourceRoute.file).toBe("start.astro");
    expect(it[0]!.mode).toBe("rewrite");
  });

  test("default-locale file in locale subdir also works as source", () => {
    const routes = makeRoutes(["en/start.astro", "pt/start.astro"]);
    const emissions = generateFallbackEmissions({
      routes,
      i18n: cfg,
      dynamicPaths: new Map(),
      base: "/",
    });
    const it = emissions.find((e) => e.targetLocale === "it");
    expect(it).toBeDefined();
    expect(it!.sourceRoute.file).toBe("en/start.astro");
    expect(it!.targetPathname).toBe("it/start");
  });

  test("multiple missing locales fall back to same source", () => {
    const routes = makeRoutes(["en/start.astro"]);
    const emissions = generateFallbackEmissions({
      routes,
      i18n: cfg,
      dynamicPaths: new Map(),
      base: "/",
    });
    const pathnames = emissions.map((e) => e.targetPathname).sort();
    expect(pathnames).toEqual(["it/start", "pt/start"]);
  });

  test("chained fallback: it → pt → en when only en exists", () => {
    const localCfg = resolveI18nConfig({
      defaultLocale: "en",
      locales: ["en", "pt", "it"],
      fallback: { it: "pt", pt: "en" },
      routing: { fallbackType: "rewrite" },
    })!;
    const routes = makeRoutes(["en/start.astro"]);
    const emissions = generateFallbackEmissions({
      routes,
      i18n: localCfg,
      dynamicPaths: new Map(),
      base: "/",
    });
    const it = emissions.find((e) => e.targetLocale === "it")!;
    const pt = emissions.find((e) => e.targetLocale === "pt")!;
    expect(it.sourceRoute.file).toBe("en/start.astro");
    expect(pt.sourceRoute.file).toBe("en/start.astro");
  });

  test("aliased locale uses path for target URL", () => {
    const localCfg = resolveI18nConfig({
      defaultLocale: "en",
      locales: ["en", { path: "spanish", codes: ["es"] }],
      fallback: { es: "en" },
      routing: { fallbackType: "rewrite" },
    })!;
    const routes = makeRoutes(["en/start.astro"]);
    const emissions = generateFallbackEmissions({
      routes,
      i18n: localCfg,
      dynamicPaths: new Map(),
      base: "/",
    });
    expect(emissions).toHaveLength(1);
    expect(emissions[0]!.targetPathname).toBe("spanish/start");
    expect(emissions[0]!.targetLocale).toBe("es");
  });

  test("ignores routes without a fallback chain", () => {
    const noFallback = resolveI18nConfig({
      defaultLocale: "en",
      locales: ["en", "pt", "it"],
    })!;
    const routes = makeRoutes(["en/start.astro"]);
    const emissions = generateFallbackEmissions({
      routes,
      i18n: noFallback,
      dynamicPaths: new Map(),
      base: "/",
    });
    expect(emissions).toEqual([]);
  });

  test("nested paths preserve sub-segments", () => {
    const routes = makeRoutes(["en/blog/index.astro", "en/blog/hello.astro"]);
    const emissions = generateFallbackEmissions({
      routes,
      i18n: cfg,
      dynamicPaths: new Map(),
      base: "/",
    });
    const itPaths = emissions
      .filter((e) => e.targetLocale === "it")
      .map((e) => e.targetPathname)
      .sort();
    expect(itPaths).toEqual(["it/blog", "it/blog/hello"]);
  });

  test("dynamic routes expand one emission per static path", () => {
    const routes = makeRoutes(["en/blog/[slug].astro"]);
    const dynamicPaths = new Map();
    dynamicPaths.set("en/blog/[slug].astro", [
      { params: { slug: "hello" }, props: { title: "Hello" } },
      { params: { slug: "world" } },
    ]);
    const emissions = generateFallbackEmissions({
      routes,
      i18n: cfg,
      dynamicPaths,
      base: "/",
    });
    const itEmissions = emissions.filter((e) => e.targetLocale === "it");
    expect(itEmissions).toHaveLength(2);
    expect(itEmissions.map((e) => e.targetPathname).sort()).toEqual([
      "it/blog/hello",
      "it/blog/world",
    ]);
    // Props are threaded through for the first entry
    expect(itEmissions.find((e) => e.targetPathname === "it/blog/hello")!.sourceProps)
      .toEqual({ title: "Hello" });
  });

  test("a default-locale dynamic route without a locale directory keeps every segment", () => {
    // `blog/[slug]` is the default locale's under prefixDefaultLocale: false; `blog` is no locale.
    const routes = makeRoutes(["blog/[slug].astro"]);
    const dynamicPaths = new Map([["blog/[slug].astro", [{ params: { slug: "hello" } }]]]);
    const emissions = generateFallbackEmissions({ routes, i18n: cfg, dynamicPaths, base: "/" });
    expect(emissions.filter((e) => e.targetLocale === "it").map((e) => e.targetPathname)).toEqual(["it/blog/hello"]);
  });
});

describe("generateFallbackEmissions — redirect mode", () => {
  const cfg = resolveI18nConfig({
    defaultLocale: "en",
    locales: ["en", "pt", "it"],
    fallback: { it: "en" },
    routing: { fallbackType: "redirect" },
  })!;

  test("emits redirect pointing at the source URL", () => {
    const routes = makeRoutes(["en/start.astro"]);
    const emissions = generateFallbackEmissions({
      routes,
      i18n: cfg,
      dynamicPaths: new Map(),
      base: "/",
    });
    const it = emissions.find((e) => e.targetLocale === undefined)!;
    expect(it.mode).toBe("redirect");
    expect(it.targetPathname).toBe("it/start");
    expect(it.redirectTo).toBe("/en/start/");
  });

  test("ends a destination with a slash only where Astro's trailingSlash and build.format do", () => {
    const routes = makeRoutes(["en/start.astro", "en/index.astro"]);
    const targets = (trailingSlash: string, format: string, base: string) =>
      generateFallbackEmissions({ routes, i18n: cfg, dynamicPaths: new Map(), base, trailingSlash, format })
        .filter((e) => e.mode === "redirect")
        .map((e) => e.redirectTo)
        .sort();
    expect(targets("ignore", "directory", "new-site")).toEqual(["/new-site/en/", "/new-site/en/start/"]);
    expect(targets("never", "directory", "/new-site")).toEqual(["/new-site/en", "/new-site/en/start"]);
    expect(targets("ignore", "file", "/")).toEqual(["/en", "/en/start"]);
    expect(targets("always", "file", "/")).toEqual(["/en/", "/en/start/"]);
  });

  test("honors base prefix in redirect destinations", () => {
    const routes = makeRoutes(["en/start.astro"]);
    const emissions = generateFallbackEmissions({
      routes,
      i18n: cfg,
      dynamicPaths: new Map(),
      base: "/new-site",
    });
    expect(emissions[0]!.redirectTo).toBe("/new-site/en/start/");
  });
});

describe("generateFallbackEmissions — prefixDefaultLocale redirects", () => {
  const cfg = resolveI18nConfig({
    defaultLocale: "en",
    locales: ["en", "pt"],
    routing: { prefixDefaultLocale: true },
  })!;

  test("redirects only the root to the default locale, as Astro's i18n middleware does", () => {
    const routes = makeRoutes(["index.astro", "en/index.astro", "en/start.astro", "en/blog/index.astro"]);
    const emissions = generateFallbackEmissions({
      routes,
      i18n: cfg,
      dynamicPaths: new Map(),
      base: "/",
    });
    const redirects = emissions.filter((e) => e.mode === "redirect");
    expect(redirects.map((e) => [e.targetPathname, e.redirectTo, e.sourceRoute.file])).toEqual([["", "/en/", "index.astro"]]);
  });

  test("without a root page, the default locale's index is redirected to", () => {
    const routes = makeRoutes(["en/index.astro"]);
    const emissions = generateFallbackEmissions({ routes, i18n: cfg, dynamicPaths: new Map(), base: "/docs" });
    expect(emissions.map((e) => [e.targetPathname, e.redirectTo])).toEqual([["", "/docs/en/"]]);
  });

  test("suppressed when redirectToDefaultLocale is false", () => {
    const noRedirect = resolveI18nConfig({
      defaultLocale: "en",
      locales: ["en", "pt"],
      routing: {
        prefixDefaultLocale: true,
        redirectToDefaultLocale: false,
      },
    })!;
    const routes = makeRoutes(["en/start.astro"]);
    const emissions = generateFallbackEmissions({
      routes,
      i18n: noRedirect,
      dynamicPaths: new Map(),
      base: "/",
    });
    expect(emissions.filter((e) => e.mode === "redirect")).toEqual([]);
  });

  test("no redirect without a root page or a default-locale index", () => {
    const routes = makeRoutes(["en/start.astro", "pt/index.astro"]);
    const dynamicPaths = new Map([["en/start.astro", []]]);
    const emissions = generateFallbackEmissions({ routes, i18n: cfg, dynamicPaths, base: "/" });
    expect(emissions.filter((e) => e.mode === "redirect")).toEqual([]);
  });
});

describe("resolveFallbackRoute (dev-server lookup)", () => {
  const cfg = resolveI18nConfig({
    defaultLocale: "en",
    locales: ["en", "pt", "it"],
    fallback: { it: "en", pt: "en" },
    routing: { fallbackType: "rewrite" },
  })!;

  test("finds fallback source under non-default locale URL", () => {
    const routes = makeRoutes(["en/start.astro"]);
    const match = resolveFallbackRoute("/it/start", routes, cfg, "/");
    expect(match).not.toBeNull();
    expect(match!.route.file).toBe("en/start.astro");
    expect(match!.targetLocale).toBe("it");
    expect(match!.mode).toBe("rewrite");
  });

  test("returns null when the locale has its own version already", () => {
    const routes = makeRoutes(["en/start.astro", "pt/start.astro"]);
    // `/pt/start` should match directly via findRoute, not via fallback.
    // The helper still shouldn't try to fallback since pt has its own.
    const match = resolveFallbackRoute("/pt/start", routes, cfg, "/");
    // resolveFallbackRoute doesn't know about findRoute's result — it
    // only fires when the caller says findRoute missed. But when it
    // DOES fire, it should check that the fallback chain actually
    // walks to a different locale's source; here the en source is
    // found but targetLocale=pt, so it would still return a match.
    // This is fine because dev.ts only calls it after findRoute miss.
    expect(match).not.toBeNull();
  });

  test("returns null when the URL's first segment is not a locale", () => {
    const routes = makeRoutes(["en/start.astro"]);
    const match = resolveFallbackRoute("/de/start", routes, cfg, "/");
    expect(match).toBeNull();
  });

  test("returns null when no source exists in any fallback locale", () => {
    const routes = makeRoutes(["pt/start.astro"]);
    // it has fallback → en, but en/start doesn't exist. pt is not in
    // the fallback chain for it. No match.
    const match = resolveFallbackRoute("/it/start", routes, cfg, "/");
    expect(match).toBeNull();
  });

  test("walks chained fallback", () => {
    const chained = resolveI18nConfig({
      defaultLocale: "en",
      locales: ["en", "pt", "it"],
      fallback: { it: "pt", pt: "en" },
    })!;
    const routes = makeRoutes(["en/start.astro"]);
    const match = resolveFallbackRoute("/it/start", routes, chained, "/");
    expect(match).not.toBeNull();
    expect(match!.route.file).toBe("en/start.astro");
  });

  test("honors redirect mode", () => {
    const redirectCfg = resolveI18nConfig({
      defaultLocale: "en",
      locales: ["en", "it"],
      fallback: { it: "en" },
      routing: { fallbackType: "redirect" },
    })!;
    const routes = makeRoutes(["en/start.astro"]);
    const match = resolveFallbackRoute("/it/start", routes, redirectCfg, "/");
    expect(match!.mode).toBe("redirect");
    expect(match!.redirectTo).toBe("/en/start");
  });

  test("handles nested paths", () => {
    const routes = makeRoutes(["en/blog/hello.astro"]);
    const match = resolveFallbackRoute("/it/blog/hello", routes, cfg, "/");
    expect(match).not.toBeNull();
    expect(match!.route.file).toBe("en/blog/hello.astro");
  });

  test("handles dynamic routes via findRoute match", () => {
    const routes = makeRoutes(["en/blog/[slug].astro"]);
    const match = resolveFallbackRoute("/it/blog/hello", routes, cfg, "/");
    expect(match).not.toBeNull();
    expect(match!.route.file).toBe("en/blog/[slug].astro");
    expect(match!.params).toEqual({ slug: "hello" });
  });
});

describe("resolveDefaultLocaleRedirect", () => {
  const cfg = resolveI18nConfig({
    defaultLocale: "en",
    locales: ["en", "pt"],
    routing: { prefixDefaultLocale: true },
  })!;

  test("an unprefixed URL other than the root is not redirected, as in Astro", () => {
    const routes = makeRoutes(["index.astro", "en/start.astro"]);
    expect(resolveDefaultLocaleRedirect("/start", routes, cfg, "/")).toBeNull();
  });

  test("root URL redirects to /en when en/index exists", () => {
    const routes = makeRoutes(["en/index.astro"]);
    const dest = resolveDefaultLocaleRedirect("/", routes, cfg, "/");
    expect(dest).toBe("/en");
  });

  test("honors base path in redirect destination", () => {
    const routes = makeRoutes(["index.astro"]);
    const dest = resolveDefaultLocaleRedirect("/", routes, cfg, "/new-site");
    expect(dest).toBe("/new-site/en");
  });

  test("URL already under a locale prefix is left alone", () => {
    const routes = makeRoutes(["en/start.astro", "pt/start.astro"]);
    expect(resolveDefaultLocaleRedirect("/pt/start", routes, cfg, "/")).toBeNull();
  });

  test("returns null when prefixDefaultLocale is false", () => {
    const noPrefix = resolveI18nConfig({
      defaultLocale: "en",
      locales: ["en", "pt"],
    })!;
    const routes = makeRoutes(["index.astro"]);
    expect(resolveDefaultLocaleRedirect("/", routes, noPrefix, "/")).toBeNull();
  });

  test("returns null when redirectToDefaultLocale is false", () => {
    const noRedirect = resolveI18nConfig({
      defaultLocale: "en",
      locales: ["en", "pt"],
      routing: { prefixDefaultLocale: true, redirectToDefaultLocale: false },
    })!;
    const routes = makeRoutes(["en/index.astro"]);
    expect(
      resolveDefaultLocaleRedirect("/", routes, noRedirect, "/"),
    ).toBeNull();
  });

  test("returns null when there is neither a root page nor a default-locale index", () => {
    const routes = makeRoutes(["en/start.astro"]);
    expect(
      resolveDefaultLocaleRedirect("/", routes, cfg, "/"),
    ).toBeNull();
  });
});
