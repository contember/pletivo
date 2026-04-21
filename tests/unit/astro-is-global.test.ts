import { describe, test, expect } from "bun:test";
import { transform } from "@astrojs/compiler";
import { classifyCompilerCss } from "../../packages/pletivo/src/astro-plugin";

async function classify(src: string) {
  const r = await transform(src, { filename: "test.astro", internalURL: "./shim.ts" });
  const scope = (r as unknown as { scope?: string }).scope ?? "";
  const css = r.css ?? [];
  const { scoped, global } = await classifyCompilerCss(css, src);
  return { scoped, global, scope, css };
}

describe("is:global CSS classification", () => {
  test("scoped <style> block is marked scoped", async () => {
    const { scoped, global, scope } = await classify(`
      <h1>x</h1>
      <style>h1 { color: red; }</style>
    `);
    expect(scoped.length).toBe(1);
    expect(scoped[0]).toContain(`.astro-${scope}`);
    expect(global.length).toBe(0);
  });

  test("<style is:global> block is marked global", async () => {
    const { scoped, global, scope } = await classify(`
      <h1>x</h1>
      <style is:global>body { background: red; }</style>
    `);
    expect(global.length).toBe(1);
    expect(global[0]).toContain("body");
    expect(global[0]).not.toContain(`.astro-${scope}`);
    expect(scoped.length).toBe(0);
  });

  test("mixed blocks split correctly", async () => {
    const { scoped, global, scope } = await classify(`
      <h1>x</h1>
      <style is:global>body { background: red; }</style>
      <style>h1 { color: blue; }</style>
    `);
    expect(scoped.length).toBe(1);
    expect(global.length).toBe(1);
    expect(scoped[0]).toContain(`.astro-${scope}`);
    expect(global[0]).toContain("body");
  });

  test("component with only is:global still classifies global", async () => {
    const { scoped, global } = await classify(`
      <style is:global>:root { --x: 1; }</style>
    `);
    expect(global.length).toBe(1);
    expect(scoped.length).toBe(0);
  });

  test("unscopable selectors (body, :root) in a scoped block stay scoped", async () => {
    // The compiler emits `body{...}` without the `:where(.astro-XXX)` marker
    // because top-level element selectors can't be scope-wrapped. A marker-
    // based classifier would misroute this to `global`; AST-based must not.
    const { scoped, global } = await classify(`
      <body></body>
      <style>body { margin: 0; }</style>
    `);
    expect(scoped.length).toBe(1);
    expect(global.length).toBe(0);
  });

  test("ignores <style> substrings inside JSX expressions", async () => {
    const { scoped, global } = await classify(`
      <div>{"<style>bogus{}</style>"}</div>
      <style>h1 { color: red; }</style>
    `);
    expect(scoped.length).toBe(1);
    expect(global.length).toBe(0);
  });

  test("ignores <style> substrings inside set:html", async () => {
    const { scoped, global } = await classify(`
      <div set:html={"<style>bogus</style>"}></div>
      <style>h1 { color: red; }</style>
    `);
    expect(scoped.length).toBe(1);
    expect(global.length).toBe(0);
  });

  test("ignores empty and comment-only <style> blocks", async () => {
    // Guards the invariant that `classifyCompilerCss` relies on: the compiler
    // emits no `css[]` entry for blocks that compile to nothing, so the AST
    // walk must skip them too. If this ever breaks, the production code does.
    const { scoped, global, css } = await classify(`
      <h1>x</h1>
      <style></style>
      <style>/* just a comment */</style>
      <style>h1 { color: red; }</style>
    `);
    expect(css.length).toBe(1);
    expect(scoped.length).toBe(1);
    expect(global.length).toBe(0);
  });

  test(":global() inside a scoped <style> block stays in the scoped bucket", async () => {
    // `:global(.foo)` tells the compiler not to scope a single selector.
    // The resulting CSS entry contains BOTH scoped rules (with
    // `:where(.astro-XXX)`) and unscoped ones (the :global() selector).
    // Classification must follow the `<style>` tag's attributes, not the
    // presence of a scope marker — so this whole entry goes to `scoped`.
    const { scoped, global, scope } = await classify(`
      <h1>x</h1>
      <p class="external">y</p>
      <style>
        h1 { color: red; }
        :global(.external) { color: blue; }
      </style>
    `);
    expect(scoped.length).toBe(1);
    expect(global.length).toBe(0);
    expect(scoped[0]).toContain(`.astro-${scope}`);
    expect(scoped[0]).toContain(".external");
  });

  test(":global()-only scoped block ships via scope-class gating", async () => {
    // A scoped <style> block with only `:global()` rules emits a CSS entry
    // with no scope markers. It still classifies as `scoped` (no is:global
    // attr) and the compiler still attaches the scope class to template
    // elements, so `getScopedCssForPage()` finds it on any page rendering
    // the component.
    const { scoped, global } = await classify(`
      <p class="external">y</p>
      <style>:global(.external) { color: blue; }</style>
    `);
    expect(scoped.length).toBe(1);
    expect(global.length).toBe(0);
    expect(scoped[0]).toContain(".external");
    // sanity: no scope marker ended up in the CSS
    expect(scoped[0]).not.toMatch(/\.astro-[a-z0-9]+/);
  });

  test("mismatched block-vs-css counts throws", async () => {
    await expect(
      classifyCompilerCss(["a{}", "b{}"], `<style>a{}</style>`),
    ).rejects.toThrow(/output contract may have changed/);
  });
});
