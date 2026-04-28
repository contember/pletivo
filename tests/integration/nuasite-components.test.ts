import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import path from "path";
import fs from "fs/promises";
import { build } from "../../packages/pletivo/src/build";
import { __resetForTests } from "../../packages/pletivo/src/astro-host/runner";
import type { PletivoConfig } from "../../packages/pletivo/src/config";

const fixtureRoot = path.join(import.meta.dir, "../fixture-nuasite-components");
const distDir = path.join(fixtureRoot, "dist");

const config: PletivoConfig = {
  outDir: "dist",
  port: 3000,
  base: "/",
  srcDir: "src",
  publicDir: "public",
};

describe("@nuasite/components <Form>", () => {
  let html: string;
  let hoistedJs: string;

  beforeAll(async () => {
    __resetForTests();
    await build(fixtureRoot, config);
    html = await Bun.file(path.join(distDir, "index.html")).text();
    const m = html.match(/\/_astro\/hoisted-([a-f0-9]+)\.js/);
    if (m) {
      hoistedJs = await Bun.file(path.join(distDir, "_astro", `hoisted-${m[1]}.js`)).text();
    } else {
      hoistedJs = "";
    }
  });

  afterAll(async () => {
    __resetForTests();
    await fs.rm(distDir, { recursive: true, force: true });
  });

  test("renders the form wrapper with slotted submit button", () => {
    // The slotted button surviving in the output proves
    // `submitButtonRegex.test(await Astro.slots.render("default"))`
    // succeeded — i.e. the slot result coerced to raw HTML rather than
    // the previous `"[object Object]"` regression.
    expect(html).toContain("<astro-form>");
    expect(html).toContain('data-form-id="contact"');
    expect(html).toContain('action="/_nua/form/contact"');
    expect(html).toContain('<button type="submit">Send</button>');
    expect(html).not.toContain("[object Object]");
  });

  test("emits honeypot fields, proving the component finished rendering", () => {
    expect(html).toContain('name="contact_required"');
    expect(html).toContain('name="website_url_required"');
    expect(html).toContain('name="phone_number_required"');
    expect(html).toContain('name="company_name_required"');
    expect(html).toMatch(/name="css_trap_[a-f0-9]{8}"/);
  });

  test("hoisted <script> ships TS-stripped — no `private`, no type annotations", () => {
    // The component's inline <script> contains `private fieldInteractions`,
    // `: HTMLFormElement`, `Set<string>`, etc. Bun's transpiler must strip
    // these before the script reaches the bundled output.
    expect(hoistedJs).toContain("customElements.define");
    expect(hoistedJs).toContain("astro-form");
    expect(hoistedJs).not.toMatch(/\bprivate\s+\w+/);
    expect(hoistedJs).not.toMatch(/:\s*HTMLFormElement\b/);
    expect(hoistedJs).not.toMatch(/Set<string>/);
    expect(hoistedJs).not.toMatch(/:\s*string\[\]/);
  });
});
