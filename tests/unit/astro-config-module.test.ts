import { afterAll, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import type { AstroConfig } from "@pletivo/core/astro-host/types";
import { astroConfigModuleSource } from "../../packages/pletivo/src/astro-config-module";

const root = new URL("file:///project/");
const outDir = new URL("dist/", root);
const config: AstroConfig = {
  root,
  srcDir: new URL("src/", root),
  publicDir: new URL("public/", root),
  outDir,
  site: "https://example.com",
  base: "/blog",
  trailingSlash: "always",
  server: { port: 4321 },
  build: { format: "directory", client: new URL("client/", outDir), server: new URL("server/", outDir), assets: "_astro" },
  integrations: [],
  vite: {},
  redirects: {},
  i18n: { defaultLocale: "en", locales: ["en", "fr"] },
};

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pletivo-astro-config-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));
let loads = 0;

async function load(source: string): Promise<Record<string, unknown>> {
  const file = path.join(scratch, `config-${loads++}.mjs`);
  fs.writeFileSync(file, source);
  return import(file);
}

describe("astro:config", () => {
  test("the client module has what Astro's manifest plugin serializes, in its order", async () => {
    const source = astroConfigModuleSource(config, "client");
    const module = await load(source);
    // A module namespace sorts its keys; the source keeps Astro's order (below).
    expect(JSON.parse(JSON.stringify({ ...module }))).toEqual({
        base: "/blog",
        i18n: {
          defaultLocale: "en",
          locales: ["en", "fr"],
          routing: { prefixDefaultLocale: false, redirectToDefaultLocale: true, fallbackType: "redirect" },
        },
        build: { format: "directory" },
        trailingSlash: "always",
        compressHTML: true,
        site: "https://example.com",
      });
    expect([...source.matchAll(/^export const (\w+)/gm)].map((match) => match[1])).toEqual([
      "base", "i18n", "build", "trailingSlash", "compressHTML", "site",
    ]);
  });

  test("the server module has the directories as URLs, cacheDir defaulted", async () => {
    const module = await load(astroConfigModuleSource(config, "server"));
    expect(module.root).toBeInstanceOf(URL);
    expect(String(module.root)).toBe("file:///project/");
    expect(String(module.cacheDir)).toBe("file:///project/node_modules/.astro/");
    expect(String(Reflect.get(Object(module.build), "server"))).toBe("file:///project/dist/server/");
  });

  test("manual i18n routing stays manual", async () => {
    const module = await load(astroConfigModuleSource({ ...config, i18n: { defaultLocale: "en", locales: ["en"], routing: "manual" } }, "client"));
    expect(Reflect.get(Object(module.i18n), "routing")).toBe("manual");
  });
});
