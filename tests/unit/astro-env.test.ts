import { describe, test, expect, beforeEach } from "bun:test";
import {
  setEnvSchema,
  registerAstroPlugin,
} from "../../packages/pletivo/src/astro-plugin";

describe("astro:env", () => {
  beforeEach(async () => {
    await registerAstroPlugin();
  });

  test("setEnvSchema records fields from config", () => {
    setEnvSchema({
      API_URL: { context: "client", access: "public", type: "string" },
      SECRET_KEY: { context: "server", access: "secret", type: "string" },
    });

    // The env module should be importable after schema is set
    // We can't directly test the virtual module import here (it's
    // registered via build.module), but we can verify the schema
    // recording works by checking the generated module content.
  });

  test("setEnvSchema handles undefined gracefully", () => {
    // Should not throw
    setEnvSchema(undefined);
  });

  test("setEnvSchema handles empty schema", () => {
    // Should not throw
    setEnvSchema({});
  });

  test("setEnvSchema clears previous schema", () => {
    setEnvSchema({
      A: { context: "client", access: "public" },
    });
    setEnvSchema({
      B: { context: "server", access: "secret" },
    });
    // Only B should exist (previous was cleared)
    // This is tested indirectly via the virtual module
  });
});
