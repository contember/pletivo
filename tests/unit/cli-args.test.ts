import { describe, expect, test } from "bun:test";
import { applyCliOverrides, readArgvOptions, readFlag } from "../../packages/pletivo/src/cli-args";
import type { PletivoConfig } from "../../packages/pletivo/src/config";

/**
 * The parsing this covers is hand-rolled `process.argv` indexing with two
 * syntaxes per flag and a flag > env > config-file precedence chain. Until
 * `cli-args.ts` was split out of `cli.ts` none of it was reachable without
 * booting a dev server, so only the `=` form of a handful of flags was tested.
 */

/**
 * A stand-in for `loadConfig()`'s result. Spelled out here rather than imported
 * so the pass-through assertions below compare against a value this file owns.
 */
const BASE: PletivoConfig = {
  outDir: "dist",
  port: 3000,
  host: "localhost",
  base: "/",
  srcDir: "src",
  publicDir: "public",
  hashAssets: true,
};

/** `argv` as the shell hands it over: [runtime, script, command, ...rest]. */
function argv(...rest: string[]): string[] {
  return ["bun", "pletivo", ...rest];
}

function apply(
  args: string[],
  env: Record<string, string | undefined> = {},
  base: Partial<PletivoConfig> = {},
): PletivoConfig {
  return applyCliOverrides({ ...BASE, ...base }, args, env);
}

describe("readFlag", () => {
  test("accepts both syntaxes and prefers the = form", () => {
    expect(readFlag(argv("dev", "--port=1"), ["--port"])).toBe("1");
    expect(readFlag(argv("dev", "--port", "2"), ["--port"])).toBe("2");
    expect(readFlag(argv("dev", "--port", "2", "--port=1"), ["--port"])).toBe("1");
  });

  test("does not swallow the next flag as a value", () => {
    expect(readFlag(argv("dev", "--port", "--host"), ["--port"])).toBeUndefined();
    expect(readFlag(argv("dev", "--port"), ["--port"])).toBeUndefined();
  });

  test("falls through the alias list in order", () => {
    expect(readFlag(argv("dev", "--not-found-page=b"), ["--404-page", "--not-found-page"])).toBe("b");
    expect(readFlag(argv("dev", "--404-page=a", "--not-found-page=b"), ["--404-page", "--not-found-page"]))
      .toBe("a");
  });
});

describe("port", () => {
  test("reads every accepted spelling", () => {
    expect(apply(argv("dev", "--port=4000")).port).toBe(4000);
    expect(apply(argv("dev", "--port", "4001")).port).toBe(4001);
    expect(apply(argv("dev", "4002")).port).toBe(4002);
  });

  test("the positional port applies to dev only", () => {
    expect(apply(argv("build", "4002")).port).toBe(BASE.port);
  });

  /**
   * `parseInt` used to take the next token whatever it was, so `--port --host`
   * bound an arbitrary port and printed `http://localhost:NaN`. A valueless
   * `--port` now reads as absent, the way every other flag does.
   */
  test("a valueless --port leaves the port alone and does not eat the next flag", () => {
    const config = apply(argv("dev", "--port", "--host"));
    expect(config.port).toBe(BASE.port);
    expect(config.host).toBe("0.0.0.0");
    expect(apply(argv("dev", "--port")).port).toBe(BASE.port);
  });

  test("refuses a value that is not a port instead of binding NaN", () => {
    expect(() => apply(argv("dev", "--port=abc"))).toThrow("--port expects a number");
    expect(() => apply(argv("dev", "--port=70000"))).toThrow("--port expects a number");
    expect(() => apply(argv("dev", "--port=1.5"))).toThrow("--port expects a number");
    expect(() => apply(argv("dev", "--port", "abc"))).toThrow("--port expects a number");
  });

  test("leaves the config file's port alone when no flag is given", () => {
    expect(apply(argv("dev"), {}, { port: 8080 }).port).toBe(8080);
  });
});

describe("host", () => {
  test("reads both syntaxes", () => {
    expect(apply(argv("dev", "--host=1.2.3.4")).host).toBe("1.2.3.4");
    expect(apply(argv("dev", "--host", "1.2.3.4")).host).toBe("1.2.3.4");
  });

  test("a bare --host means every interface", () => {
    expect(apply(argv("dev", "--host")).host).toBe("0.0.0.0");
    expect(apply(argv("dev", "--host", "--stale")).host).toBe("0.0.0.0");
  });

  test("no flag leaves the config file's host alone", () => {
    expect(apply(argv("dev"), {}, { host: "example.test" }).host).toBe("example.test");
  });
});

describe("404 page", () => {
  test("flag beats env beats config file", () => {
    const base = { notFoundPage: "from-config.tsx" };
    expect(apply(argv("dev"), {}, base).notFoundPage).toBe("from-config.tsx");
    expect(apply(argv("dev"), { PLETIVO_404_PAGE: "from-env.tsx" }, base).notFoundPage)
      .toBe("from-env.tsx");
    expect(apply(argv("dev", "--404-page=from-flag.tsx"), { PLETIVO_404_PAGE: "from-env.tsx" }, base)
      .notFoundPage).toBe("from-flag.tsx");
  });

  test("--not-found-page is an alias", () => {
    expect(apply(argv("dev", "--not-found-page=alias.tsx")).notFoundPage).toBe("alias.tsx");
  });
});

describe("dev hybrid options", () => {
  test("stays absent when nothing asks for it", () => {
    expect(apply(argv("dev")).dev).toBeUndefined();
  });

  test("flags win over env", () => {
    const config = apply(
      argv("dev", "--error-page=flag.tsx", "--stale", "--debug-header=x-flag"),
      { PLETIVO_ERROR_PAGE: "env.tsx", PLETIVO_DEBUG_HEADER: "x-env" },
    );
    expect(config.dev).toEqual({ errorPage: "flag.tsx", stale: true, debugHeader: "x-flag" });
  });

  test("env alone is enough to turn the block on", () => {
    expect(apply(argv("dev"), { PLETIVO_ERROR_PAGE: "env.tsx" }).dev)
      .toEqual({ errorPage: "env.tsx" });
    expect(apply(argv("dev"), { PLETIVO_DEBUG_HEADER: "x-env" }).dev)
      .toEqual({ debugHeader: "x-env" });
  });

  test("PLETIVO_STALE treats 0 and empty as off", () => {
    expect(apply(argv("dev"), { PLETIVO_STALE: "1" }).dev).toEqual({ stale: true });
    expect(apply(argv("dev"), { PLETIVO_STALE: "yes" }).dev).toEqual({ stale: true });
    expect(apply(argv("dev"), { PLETIVO_STALE: "0" }).dev).toEqual({});
    expect(apply(argv("dev"), { PLETIVO_STALE: "" }).dev).toBeUndefined();
  });

  test("merges on top of the config file rather than replacing it", () => {
    const config = apply(argv("dev", "--stale"), {}, { dev: { errorPage: "from-config.tsx" } });
    expect(config.dev).toEqual({ errorPage: "from-config.tsx", stale: true });
  });

  test("does not mutate the config file's dev object", () => {
    const fromConfig = { errorPage: "from-config.tsx" };
    apply(argv("dev", "--stale"), {}, { dev: fromConfig });
    expect(fromConfig).toEqual({ errorPage: "from-config.tsx" });
  });
});

describe("readArgvOptions", () => {
  test("reads the command and the boolean flags", () => {
    expect(readArgvOptions(argv("build", "--incremental", "--clean")))
      .toEqual({ command: "build", incremental: true, clean: true, noRestart: false });
    expect(readArgvOptions(argv("dev", "--no-restart")))
      .toEqual({ command: "dev", incremental: false, clean: false, noRestart: true });
    expect(readArgvOptions(argv()).command).toBeUndefined();
  });
});
