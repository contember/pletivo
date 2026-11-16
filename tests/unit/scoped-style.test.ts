import { describe, expect, test } from "bun:test";
import { extractAstroScopes, resolveScopedStyleStrategy } from "@pletivo/core/astro-host/scoped-style";
import type { AstroConfig } from "@pletivo/core/astro-host/types";

function astroConfig(extra: Record<string, unknown>): AstroConfig {
  const root = new URL("file:///site/");
  return {
    root,
    srcDir: root,
    publicDir: root,
    outDir: root,
    base: "/",
    trailingSlash: "ignore",
    build: { format: "directory", client: root, server: root, assets: "_astro" },
    integrations: [],
    vite: {},
    redirects: {},
    ...extra,
  };
}

describe("resolveScopedStyleStrategy", () => {
  test("leaves a pletivo-native project to the compiler default", () => {
    expect(resolveScopedStyleStrategy(undefined)).toBeUndefined();
  });

  test("gives an Astro project Astro's default, attribute", () => {
    expect(resolveScopedStyleStrategy(astroConfig({}))).toBe("attribute");
  });

  test("keeps a configured strategy and refuses an unknown one", () => {
    expect(resolveScopedStyleStrategy(astroConfig({ scopedStyleStrategy: "where" }))).toBe("where");
    expect(() => resolveScopedStyleStrategy(astroConfig({ scopedStyleStrategy: "inline" }))).toThrow(
      /scopedStyleStrategy "inline"/,
    );
  });
});

describe("extractAstroScopes", () => {
  test("reads scope ids from classes and data-astro-cid attributes alike", () => {
    const html = '<p class="card astro-a1b2c3d4" data-astro-cid-e5f6g7h8>x</p>';
    expect([...extractAstroScopes(html)].sort()).toEqual(["a1b2c3d4", "e5f6g7h8"]);
  });
});
