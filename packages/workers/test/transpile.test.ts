import { describe, expect, test } from "bun:test";
import path from "node:path";
import { stripTypes, TranspileError } from "../src/transpile.ts";

const PACKAGE_DIR = path.resolve(import.meta.dir, "..");

describe("stripTypes", () => {
  test("removes an interface and leaves every other byte where it was", () => {
    const code =
      'import Card from "./Card.astro";\n' +
      "export interface Props {\n  title: string;\n}\n" +
      "const { title } = Astro.props;\n";
    // The blank lines are the point: sucrase blanks a removed range rather than
    // closing it up, so a later error's line number still lands on the right line.
    expect(stripTypes(code, { file: "src/components/Card.astro" })).toBe(
      'import Card from "./Card.astro";\n\n\n\nconst { title } = Astro.props;\n',
    );
  });

  test("strips annotations out of declarations and signatures", () => {
    expect(
      stripTypes("const n: number = 1;\nfunction f(a: string): string { return a; }\n", {
        file: "a.astro",
      }),
    ).toBe("const n = 1;\nfunction f(a) { return a; }\n");
  });

  test("returns a module with no TypeScript byte for byte", () => {
    // The invariant the whole wiring rests on: adding this step cannot move a page
    // that already rendered, because for those pages it is the identity function.
    const code =
      'import { render as $$render } from "./pletivo-runtime.js";\n' +
      'export default $$createComponent(async ($$result) => $$render`<p>${"x"}</p>`);\n';
    expect(stripTypes(code, { file: "src/pages/index.astro" })).toBe(code);
  });

  test("keeps a value import nothing references, so the module graph does not move", () => {
    // Default sucrase would elide this. `collectSpecifiers` and the CSS cascade read
    // the same prologue the isolate does, so the two must not disagree.
    const code = 'import Card from "./Card.astro";\nexport const x = 1;\n';
    expect(stripTypes(code, { file: "a.astro" })).toBe(code);
  });

  test("drops an explicit `import type`, which never was an edge", () => {
    expect(
      stripTypes('import type { Props } from "./types.ts";\nexport const x = 1;\n', {
        file: "a.astro",
      }),
    ).toBe("\nexport const x = 1;\n");
  });

  test("leaves syntax V8 already has alone", () => {
    // disableESTransforms. Downlevelling private fields or `??` would only move the
    // isolate further from what the Bun host runs.
    const code = "class A { #x = 1; y = a?.b ?? 2; }\nexport { A };\n";
    expect(stripTypes(code, { file: "a.astro" })).toBe(code);
  });

  test("names the file when the module does not parse", () => {
    let thrown: unknown;
    try {
      stripTypes("const = ;", { file: "src/pages/index.astro" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TranspileError);
    expect((thrown as TranspileError).file).toBe("src/pages/index.astro");
    expect((thrown as TranspileError).message).toContain("src/pages/index.astro");
  });
});

/**
 * The package's CLI and require-hook entries pull in `mz`, `pirates`, `commander`
 * and `tinyglobby`, none of which run in an isolate. Nothing in the transform path
 * reaches them today — this fails if a sucrase upgrade moves that line.
 */
describe("the sucrase entry a Worker bundle takes", () => {
  /** What a bundler picks for a Worker: the `module` field, not `main`. */
  const manifest: unknown = require("sucrase/package.json");
  const moduleField: unknown =
    typeof manifest === "object" && manifest !== null ? Reflect.get(manifest, "module") : undefined;

  test("advertises an ESM entry", () => {
    expect(moduleField).toBe("dist/esm/index.js");
  });

  test("pulls in no Node-only dependency, and stays small", async () => {
    const entry = Bun.resolveSync(`sucrase/${String(moduleField)}`, PACKAGE_DIR);
    const resolved: string[] = [];
    const built = await Bun.build({
      entrypoints: [entry],
      target: "node",
      format: "esm",
      minify: true,
      plugins: [
        {
          name: "record-specifiers",
          setup(builder) {
            builder.onResolve({ filter: /.*/ }, (args) => {
              resolved.push(args.path);
              return undefined;
            });
          },
        },
      ],
    });
    expect(built.success).toBe(true);

    const bare = resolved.filter((specifier) => !specifier.startsWith(".") && !specifier.startsWith("/"));
    expect(bare).not.toContain("mz");
    expect(bare).not.toContain("mz/fs");
    expect(bare).not.toContain("pirates");
    expect(bare).not.toContain("commander");
    expect(bare).not.toContain("tinyglobby");

    // 47 KB gzipped as measured. The ceiling is there to catch the failure mode that
    // matters — a stripper that drags the `typescript` package in weighs 1.01 MB.
    const text = await built.outputs[0].text();
    const gzipped = Bun.gzipSync(new TextEncoder().encode(text), { level: 9 }).length;
    expect(gzipped).toBeLessThan(150_000);
  });
});
