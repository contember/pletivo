import { describe, test, expect } from "bun:test";
import { envModuleSource, parseEnvConfig } from "../../packages/pletivo/src/astro-env";

// What astro/config's envField helpers return: the options plus `type`.
const schema = {
  FOO: { type: "string", context: "client", access: "public", optional: true, default: "ABC" },
  PORT: { type: "number", context: "server", access: "public", int: true },
  DEBUG: { type: "boolean", context: "client", access: "public", default: false },
  MODE: { type: "enum", values: ["a", "b"], context: "server", access: "public", optional: true },
  TOKEN: { type: "string", context: "server", access: "secret", default: "none" },
};

describe("astro:env", () => {
  test("a client module has the public client variables, defaults and types applied", () => {
    const source = envModuleSource(parseEnvConfig({ schema }), "client", { DEBUG: "true", PORT: "8080" });
    expect(source).toBe('export const FOO = "ABC";\nexport const DEBUG = true;');
  });

  test("a server module types its public variables and reads a secret when the page runs", () => {
    const source = envModuleSource(parseEnvConfig({ schema }), "server", { PORT: "8080", MODE: "b", TOKEN: "s3cret" });
    expect(source).toContain("export const PORT = 8080;");
    expect(source).toContain('export const MODE = "b";');
    expect(source).toContain('export const TOKEN = process.env["TOKEN"] || "none";');
    expect(source).not.toContain("s3cret");
  });

  test("an empty value counts as unset, as in Astro", () => {
    const source = envModuleSource(parseEnvConfig({ schema }), "client", { FOO: "" });
    expect(source).toContain('export const FOO = "ABC";');
  });

  test("invalid public variables fail with Astro's message", () => {
    const fields = parseEnvConfig({ schema });
    expect(() => envModuleSource(fields, "server", { PORT: "1.5", MODE: "c" })).toThrow(
      "The following environment variables defined in `env.schema` are invalid:\n\n" +
        "- The following constraints for PORT are not met: int\n" +
        "- MODE's type is invalid, expected: 'a' | 'b'\n",
    );
    expect(() => envModuleSource(fields, "server", {})).toThrow("- PORT is missing");
  });

  test("a schema envField cannot produce is rejected when the config loads", () => {
    expect(parseEnvConfig(undefined)).toEqual([]);
    expect(() => parseEnvConfig({ schema: { X: { type: "date", context: "server", access: "public" } } })).toThrow(
      'astro config: env.schema.X.type must be "string", "number", "boolean" or "enum"',
    );
    expect(() => parseEnvConfig({ schema: { X: { type: "string", context: "client", access: "secret" } } })).toThrow(
      "a client variable cannot be secret",
    );
  });
});
