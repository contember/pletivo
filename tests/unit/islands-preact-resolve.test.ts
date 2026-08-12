/**
 * The island bundle must ship *real* Preact, not the SSR hook stub.
 *
 * `tsconfig.json` maps the bare specifier `preact/hooks` onto
 * `packages/runtime/src/hooks.ts` — a deliberate no-op stub, correct for SSR.
 * Bun applies tsconfig `paths` at runtime, so any bare-specifier resolve inside
 * `islandPlugin()` picks up that mapping too and pins the *client* bundle to the
 * stub. The failure is silent: the build stays green and the island renders once
 * and never reacts. So these assert on the resolved path and on bundle content,
 * never on the build succeeding.
 *
 * See docs/todos/013-preact-hooks-ssr-stub-leak.md.
 */
import { describe, test, expect } from "bun:test";
import path from "path";
import os from "os";
import fs from "fs/promises";
import { islandPlugin } from "../../packages/pletivo/src/islands-bundle";

const repoRoot = path.resolve(import.meta.dir, "../..");
const stubPath = path.join(repoRoot, "packages/runtime/src/hooks.ts");

/**
 * Run the plugin's `setup()` against a recording stand-in for Bun's build
 * object and replay one specifier through the handlers it registered. That is
 * the same path a real bundle takes, without paying for a bundle.
 */
function resolveThroughPlugin(spec: string, projectRoot?: string): string {
  const handlers: Array<{ filter: RegExp; onResolve: (args: { path: string }) => { path: string } }> = [];
  const build = {
    onResolve(options: { filter: RegExp }, onResolve: (args: { path: string }) => { path: string }) {
      handlers.push({ filter: options.filter, onResolve });
    },
  };
  islandPlugin(projectRoot).setup(build);
  const match = handlers.find((h) => h.filter.test(spec));
  if (!match) throw new Error(`islandPlugin registered no handler for "${spec}"`);
  return match.onResolve({ path: spec }).path;
}

const preactRoot = (() => {
  let dir = path.dirname(require.resolve("preact"));
  for (;;) {
    const parent = path.dirname(dir);
    if (path.basename(dir) === "preact") return dir;
    if (parent === dir) throw new Error("could not locate the preact package root");
    dir = parent;
  }
})();

describe("islandPlugin preact resolution", () => {
  // The bug, exactly: the plugin handed the client bundle the SSR stub.
  test("preact/hooks resolves into the preact package, not the SSR stub", () => {
    const resolved = resolveThroughPlugin("preact/hooks");
    expect(resolved).not.toBe(stubPath);
    expect(resolved.startsWith(preactRoot + path.sep)).toBe(true);
  });

  // pletivo/hooks is the specifier user islands are told to import; it lands on
  // the same resolution, so it has to be checked separately.
  test("pletivo/hooks resolves into the preact package, not the SSR stub", () => {
    const resolved = resolveThroughPlugin("pletivo/hooks");
    expect(resolved).not.toBe(stubPath);
    expect(resolved.startsWith(preactRoot + path.sep)).toBe(true);
  });

  // hooks is the one that is mapped today; the others are only safe because
  // nobody has mapped them yet, and a user's own tsconfig can.
  test.each([
    ["preact/compat", "compat"],
    ["preact/jsx-runtime", "jsx-runtime"],
    ["preact/jsx-dev-runtime", "jsx-runtime"],
    ["react", "compat"],
    ["react-dom", "compat"],
    ["react/jsx-runtime", "jsx-runtime"],
  ])("%s resolves inside the preact package", (spec, subdir) => {
    const resolved = resolveThroughPlugin(spec);
    expect(resolved.startsWith(path.join(preactRoot, subdir) + path.sep)).toBe(true);
  });

  // Ground truth with the mapping absent is preact's `import` condition. The
  // relative-specifier escape hatch (`./hooks` from the package root) silently
  // lands on `require` instead, so pin the condition.
  test.each(["preact/hooks", "preact/compat", "preact/jsx-runtime"])(
    "%s takes the ESM import condition from preact's exports map",
    (spec) => {
      expect(resolveThroughPlugin(spec).endsWith(".mjs")).toBe(true);
    },
  );

  // A project root is what build.ts/dev.ts actually pass.
  test("a project root does not reintroduce the stub", () => {
    const resolved = resolveThroughPlugin("preact/hooks", path.join(repoRoot, "examples/basic"));
    expect(resolved).not.toBe(stubPath);
    expect(resolved.startsWith(preactRoot + path.sep)).toBe(true);
  });

  // Everything must come out of one preact copy, or Radix gets two React
  // context registries and throws "X must be used within Y".
  test("every specifier comes from the same preact copy", () => {
    const roots = new Set(
      ["preact", "preact/hooks", "preact/compat", "preact/jsx-runtime", "react", "react-dom"].map(
        (spec) => resolveThroughPlugin(spec).slice(0, preactRoot.length),
      ),
    );
    expect([...roots]).toEqual([preactRoot]);
  });
});

describe("island bundle content", () => {
  // The build stayed green through the whole bug, so assert on the bytes.
  // `__H` / `__N` are preact's mangled hook-state internals: present in
  // hooks.mjs, absent from the stub and from preact core.
  test("a bundled island carries Preact's hook internals", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pletivo-island-bundle-"));
    try {
      const entry = path.join(tmp, "entry.ts");
      await fs.writeFile(
        entry,
        `import { useState } from "preact/hooks";\n` +
          `import { h } from "preact";\n` +
          `export function mount(el) { return h("div", null, useState(0)[0]); }\n`,
      );
      const result = await Bun.build({
        entrypoints: [entry],
        format: "esm",
        minify: true,
        plugins: [islandPlugin(repoRoot)],
      });
      expect(result.success).toBe(true);
      const code = await result.outputs[0]!.text();
      expect(code).toContain("__H");
      expect(code).toContain("__N");
      // The stub's whole body is a handful of no-ops; real hooks are ~20 kB.
      expect(code.length).toBeGreaterThan(10_000);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("island bundle runtime", () => {
  /**
   * Real preact hooks install themselves onto the core's `options` object at
   * module scope (`options.__r`, `options.diffed`, `options.unmount`). Importing
   * the built bundle and finding those hooks in place proves two things at once
   * that no string match can: the hooks module is the real one, and it reached
   * the *same* preact instance the island renders with. No DOM needed — none of
   * this touches `document`.
   */
  test("the bundled hooks install themselves on the bundled preact's options", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pletivo-island-runtime-"));
    try {
      const entry = path.join(tmp, "entry.ts");
      await fs.writeFile(
        entry,
        `import { options } from "preact";\n` +
          `import { useState } from "preact/hooks";\n` +
          `export { options, useState };\n`,
      );
      const result = await Bun.build({
        entrypoints: [entry],
        outdir: path.join(tmp, "out"),
        format: "esm",
        naming: "[name].mjs",
        plugins: [islandPlugin(repoRoot)],
      });
      expect(result.success).toBe(true);

      const bundled = await import(path.join(tmp, "out", "entry.mjs"));
      expect(typeof bundled.options.__r).toBe("function");
      expect(typeof bundled.options.diffed).toBe("function");
      expect(typeof bundled.options.unmount).toBe("function");

      const stub = await import("../../packages/runtime/src/hooks");
      expect(bundled.useState).not.toBe(stub.useState);
      // The stub's setter is a literal no-op with no hook state behind it.
      expect(bundled.useState.length).toBe(1);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("SSR keeps the stub", () => {
  // The fix must move only the client path. Server renders still go through
  // packages/runtime/src/hooks.ts, which is what makes SSR of a stateful island
  // a single pass instead of a hook-dispatch error.
  test("preact/hooks on the server is the no-op stub", async () => {
    const [asSeenByTheServer, stub] = await Promise.all([
      import("preact/hooks"),
      import("../../packages/runtime/src/hooks"),
    ]);
    expect(asSeenByTheServer.useState).toBe(stub.useState);
    expect(asSeenByTheServer.useEffect).toBe(stub.useEffect);
  });

  test("the stub's useState never updates and useEffect never runs", async () => {
    const { useState, useEffect } = await import("preact/hooks");
    const [value, setValue] = useState(1);
    setValue(2);
    expect(value).toBe(1);
    let ran = false;
    useEffect(() => {
      ran = true;
    });
    expect(ran).toBe(false);
  });
});
