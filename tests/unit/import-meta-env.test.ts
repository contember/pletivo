import { afterEach, describe, expect, test } from "bun:test";
import type { AstroConfig } from "@pletivo/core/astro-host/types";
import { IMPORT_META_ENV_GLOBAL } from "@pletivo/core/import-meta-env";
import {
  importMetaEnvBuiltins,
  installImportMetaEnv,
  substituteImportMetaEnv,
} from "../../packages/pletivo/src/import-meta-env";

const REWRITTEN = `(globalThis.${IMPORT_META_ENV_GLOBAL} ?? process.env)`;

function astroConfig(overrides: Partial<AstroConfig>): AstroConfig {
  const root = new URL("file:///project/");
  return {
    root,
    srcDir: new URL("src/", root),
    publicDir: new URL("public/", root),
    outDir: new URL("dist/", root),
    base: "/",
    trailingSlash: "ignore",
    build: { format: "directory", client: root, server: root, assets: "_astro" },
    integrations: [],
    vite: {},
    redirects: {},
    ...overrides,
  };
}

describe("substituteImportMetaEnv", () => {
  test("rewrites expressions", () => {
    const source = [
      "const a = import.meta.env.BASE_URL;",
      "const { MODE } = import.meta . env;",
      "const t = typeof import.meta.env;",
      "const d = import.meta.env?.DEV;",
      'import.meta.env.FOO = "1";',
    ].join("\n");
    expect(substituteImportMetaEnv(source, "ts")).toBe(
      [
        `const a = ${REWRITTEN}.BASE_URL;`,
        `const { MODE } = ${REWRITTEN};`,
        `const t = typeof ${REWRITTEN};`,
        `const d = ${REWRITTEN}?.DEV;`,
        `${REWRITTEN}.FOO = "1";`,
      ].join("\n"),
    );
  });

  test("leaves strings, templates, comments, regexes, types and JSX text as written", () => {
    const source = [
      "type E = typeof import.meta.env;",
      'const s = "import.meta.env.PUBLIC_X"; // import.meta.env',
      "const t = `see import.meta.env ${import.meta.env.SITE}`;",
      "const r = /import.meta.env/;",
      "const el = <p>import.meta.env.BASE_URL</p>;",
    ].join("\n");
    expect(substituteImportMetaEnv(source, "tsx")).toBe(
      source.replace("${import.meta.env.SITE}", `\${${REWRITTEN}.SITE}`),
    );
  });

  test("keeps JSX and line numbers for the loader that compiles the file next", () => {
    const source = "const el = <div>{import.meta.env.MODE}</div>;\nexport default el;";
    const result = substituteImportMetaEnv(source, "jsx");
    expect(result).toBe(`const el = <div>{${REWRITTEN}.MODE}</div>;\nexport default el;`);
  });

  test("source that already contains the placeholder text does not confuse it", () => {
    const source = "const s = '__pletivo_import_meta_env_code_0__'; const t = 'import.meta.env'; const u = import.meta.env.MODE;";
    expect(substituteImportMetaEnv(source, "ts")).toBe(
      `const s = '__pletivo_import_meta_env_code_0__'; const t = 'import.meta.env'; const u = ${REWRITTEN}.MODE;`,
    );
  });

  test("leaves unparseable code to the loader", () => {
    const source = "const = import.meta.env.MODE;";
    expect(substituteImportMetaEnv(source, "ts")).toBe(source);
  });
});

describe("importMetaEnvBuiltins", () => {
  test.each([
    ["never", "/docs/", "/docs"],
    ["never", "/", "/"],
    ["always", "/docs", "/docs/"],
    ["always", "/", "/"],
    ["ignore", "/docs", "/docs"],
    ["ignore", "/docs/", "/docs/"],
    ["ignore", "docs", "/docs"],
  ])("trailingSlash %s with base %s gives BASE_URL %s", (trailingSlash, base, expected) => {
    const builtins = importMetaEnvBuiltins({ mode: "build", base: "/", astroConfig: astroConfig({ base, trailingSlash }) });
    expect(builtins.BASE_URL).toBe(expected);
  });

  test("a pletivo-native project takes pletivo's base", () => {
    expect(importMetaEnvBuiltins({ mode: "build", base: "sub" }).BASE_URL).toBe("/sub");
  });

  test("dev and build modes", () => {
    expect(importMetaEnvBuiltins({ mode: "dev", base: "/" })).toMatchObject({
      MODE: "development",
      DEV: true,
      PROD: false,
      SSR: true,
    });
    expect(importMetaEnvBuiltins({ mode: "build", base: "/" })).toMatchObject({
      MODE: "production",
      DEV: false,
      PROD: true,
      SSR: true,
    });
  });

  test("SITE and ASSETS_PREFIX come from the Astro config", () => {
    const config = astroConfig({ site: "https://example.com" });
    config.build.assetsPrefix = "https://cdn.example.com";
    expect(importMetaEnvBuiltins({ mode: "build", base: "/", astroConfig: config })).toMatchObject({
      SITE: "https://example.com",
      ASSETS_PREFIX: "https://cdn.example.com",
    });
  });
});

describe("installImportMetaEnv", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, IMPORT_META_ENV_GLOBAL);
    delete process.env.PLETIVO_TEST_LATE;
    delete process.env.PLETIVO_TEST_WRITTEN;
    delete process.env.SITE;
    delete process.env.PLETIVO_TEST_DEFINED;
  });

  function installed(): object {
    installImportMetaEnv({ mode: "build", base: "/" });
    const env: unknown = Reflect.get(globalThis, IMPORT_META_ENV_GLOBAL);
    if (typeof env !== "object" || env === null) throw new Error("not installed");
    return env;
  }

  test("reads process.env live, including variables set after install", () => {
    const env = installed();
    process.env.PLETIVO_TEST_LATE = "late";
    expect(Reflect.get(env, "PLETIVO_TEST_LATE")).toBe("late");
    expect(Object.keys(env)).toContain("PLETIVO_TEST_LATE");
  });

  test("a write reaches process.env", () => {
    Reflect.set(installed(), "PLETIVO_TEST_WRITTEN", "yes");
    expect(process.env.PLETIVO_TEST_WRITTEN).toBe("yes");
  });

  test("only process.env's own keys are its keys", () => {
    const env = installed();
    expect(Object.hasOwn(env, "constructor")).toBe(false);
    expect("toString" in env).toBe(false);
    expect(Object.hasOwn(env, "PATH")).toBe(true);
    expect(Object.hasOwn(env, "DEV")).toBe(true);
  });

  test("delete removes a built-in, and an env key from process.env", () => {
    const env = installed();
    process.env.PLETIVO_TEST_WRITTEN = "x";
    expect(Reflect.deleteProperty(env, "DEV")).toBe(true);
    expect("DEV" in env).toBe(false);
    expect(Reflect.deleteProperty(env, "PLETIVO_TEST_WRITTEN")).toBe(true);
    expect(process.env.PLETIVO_TEST_WRITTEN).toBeUndefined();
  });

  test("defineProperty writes a plain data property to process.env and refuses the rest", () => {
    const env = installed();
    const plain = { value: "v", writable: true, enumerable: true, configurable: true };
    expect(Reflect.defineProperty(env, "PLETIVO_TEST_DEFINED", plain)).toBe(true);
    expect(process.env.PLETIVO_TEST_DEFINED).toBe("v");
    expect(Reflect.defineProperty(env, "PLETIVO_TEST_DEFINED", { get: () => "x" })).toBe(false);
    expect(Reflect.defineProperty(env, "PLETIVO_TEST_DEFINED", { value: "w", configurable: false })).toBe(false);
    expect(Reflect.defineProperty(env, "MODE", { value: "test" })).toBe(true);
    expect(Reflect.get(env, "MODE")).toBe("test");
  });

  test("a spread copy is structured-cloneable", () => {
    const env = installed();
    expect(structuredClone({ ...env })).toMatchObject({ DEV: false, PATH: process.env.PATH });
  });

  test("built-ins shadow process.env, even when undefined", () => {
    process.env.SITE = "from-shell";
    const env = { ...installed() };
    expect(env).toMatchObject({ DEV: false, PATH: process.env.PATH });
    expect(Reflect.get(env, "SITE")).toBeUndefined();
  });
});
