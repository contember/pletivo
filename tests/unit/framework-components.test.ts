import { describe, expect, test } from "bun:test";
import { jsx } from "@pletivo/runtime/jsx-runtime";
import { createComponent, renderAstroPage, renderComponent } from "@pletivo/runtime/astro-shim";
import { createHtml } from "@pletivo/runtime/html-string";
import { jsxImportSourcePragma } from "@pletivo/core/framework-jsx";
import { h } from "preact";

/**
 * Bun's file loader makes an import of a file it has no module for (`.svelte`,
 * `.vue`, …) evaluate to the file's path. Rendered as a tag, that path was a
 * wrong page with no error.
 */
const SVELTE_FILE = "/project/src/components/Counter.svelte";

function astroPageRendering(component: unknown) {
  return createComponent(async (result) => {
    const rendered = await renderComponent(result, "Counter", component, {}, {});
    return createHtml(`<main>${rendered.__html}</main>`);
  }, "page");
}

describe("an imported file in a component position", () => {
  test("fails a .astro render by framework and file", async () => {
    await expect(renderAstroPage(astroPageRendering(SVELTE_FILE), {})).rejects.toThrow(
      `pletivo cannot render Svelte components: ${SVELTE_FILE}`,
    );
  });

  test("fails a JSX render by framework and file", () => {
    expect(() => jsx("/project/src/components/Counter.vue", {})).toThrow(
      "pletivo cannot render Vue components: /project/src/components/Counter.vue",
    );
  });

  test("fails for a file of no known framework too", () => {
    expect(() => jsx("C:\\project\\src\\Widget.marko", {})).toThrow(
      "pletivo cannot render C:\\project\\src\\Widget.marko as a component: pletivo has no module loader for .marko files, so the import evaluated to its path.",
    );
  });

  test("leaves element names alone", async () => {
    expect(await renderAstroPage(astroPageRendering("custom-element"), {})).toBe(
      "<main><custom-element></custom-element></main>",
    );
    const input = jsx("input", { type: "text" });
    expect(input instanceof Promise ? await input : input).toEqual(createHtml('<input type="text">'));
  });
});

/** React's element and `forwardRef` shapes, by the markers React sets (React is not a dependency here). */
function ReactCounter() {
  return null;
}
const reactElement = { $$typeof: Symbol.for("react.transitional.element"), type: ReactCounter, key: null, props: {} };
const forwardRefComponent = { $$typeof: Symbol.for("react.forward_ref"), render: ReactCounter, displayName: "Button" };

describe("another framework's element reaching pletivo's renderer", () => {
  test("fails a .astro render, naming the component that returned it", async () => {
    await expect(renderAstroPage(astroPageRendering(() => reactElement), {})).rejects.toThrow(
      "pletivo cannot render React components: <Counter> returned a React element (<ReactCounter>)",
    );
  });

  test("fails a .astro render of a Preact vnode in an expression", async () => {
    const page = createComponent(async (_result) => {
      // What `{vnode}` in a template reaches: the shim's value renderer.
      const rendered = await renderComponent(_result, "Wrapper", () => [h("b", null, "x")], {}, {});
      return createHtml(rendered.__html);
    }, "page");
    await expect(renderAstroPage(page, {})).rejects.toThrow("pletivo cannot render Preact components: a Preact element (<b>)");
  });

  test("fails a JSX render of a Vue vnode child", () => {
    expect(() => jsx("div", { children: { __v_isVNode: true, type: { __name: "VueCounter" }, props: null } })).toThrow(
      "pletivo cannot render Vue components: a Vue element (<VueCounter>)",
    );
  });

  test("fails on a component object instead of rendering nothing", async () => {
    await expect(renderAstroPage(astroPageRendering(forwardRefComponent), {})).rejects.toThrow(
      "pletivo cannot render React components: <Counter> is a React component object (<Button>)",
    );
    // Typed JSX cannot pass an object tag; compiled JSX does, so call it untyped.
    expect(() => Reflect.apply(jsx, undefined, [forwardRefComponent, {}])).toThrow(
      "pletivo cannot render React components: <Button> is a React component object (<Button>)",
    );
    await expect(renderAstroPage(astroPageRendering({ label: "x" }), {})).rejects.toThrow(
      "pletivo cannot render <Counter>: a component must be a function, an .astro component or an element name, not a value of type object.",
    );
  });

  test("says an image import is not a component, and what to write instead", async () => {
    const logo = { src: "/_astro/logo.1a2b.svg", width: 24, height: 24, format: "svg" };
    await expect(renderAstroPage(astroPageRendering(logo), {})).rejects.toThrow(
      "pletivo cannot render <Counter>: it is an image import, which pletivo does not render as a component " +
        "(Astro renders an imported SVG inline). Use <img src={Counter.src}> instead.",
    );
  });

  test("names a JSX component that returns another framework's element", async () => {
    function Badge() {
      return reactElement;
    }
    async function AsyncBadge() {
      return reactElement;
    }
    // Typed JSX cannot return a React element; compiled React JSX does, so call it untyped.
    expect(() => Reflect.apply(jsx, undefined, [Badge, {}])).toThrow(
      "pletivo cannot render React components: <Badge> returned a React element (<ReactCounter>)",
    );
    await expect(Reflect.apply(jsx, undefined, [AsyncBadge, {}])).rejects.toThrow(
      "pletivo cannot render React components: <AsyncBadge> returned a React element (<ReactCounter>)",
    );
  });

  test("still stringifies other objects, as Astro does", async () => {
    const page = createComponent(async (result) => {
      const rendered = await renderComponent(result, "Wrapper", () => [{ toString: () => "plain" }], {}, {});
      return createHtml(rendered.__html);
    }, "page");
    expect(await renderAstroPage(page, {})).toBe("plain");
  });
});

describe("a Promise component", () => {
  test("is awaited, as Astro does", async () => {
    const greeting = Promise.resolve(() => createHtml("<b>hi</b>"));
    expect(await renderAstroPage(astroPageRendering(greeting), {})).toBe("<main><b>hi</b></main>");
  });
});

describe("the @jsxImportSource pragma", () => {
  test("is read from the leading comments, the last one winning as in Bun", () => {
    expect(jsxImportSourcePragma("/** @jsxImportSource react */\nexport {};")).toEqual({ kind: "leading", importSource: "react" });
    expect(jsxImportSourcePragma("/* @jsxImportSource react */\n// @jsxImportSource pletivo\nexport {};")).toEqual({
      kind: "leading",
      importSource: "pletivo",
    });
  });

  test("is absent when no comment names one", () => {
    expect(jsxImportSourcePragma("// header\nexport {};")).toEqual({ kind: "none" });
  });

  test("is unknown when the text occurs after the first statement, so the tsconfig does not decide", () => {
    // Bun honours a pragma below the imports; the reader cannot tell it from a string.
    expect(jsxImportSourcePragma("import x from 'y';\n/** @jsxImportSource pletivo */")).toEqual({ kind: "unknown" });
    expect(jsxImportSourcePragma('export const s = "/** @jsxImportSource react */";')).toEqual({ kind: "unknown" });
    expect(jsxImportSourcePragma("/** @jsxImportSource react */\nconst s = 1; /** @jsxImportSource preact */")).toEqual({
      kind: "unknown",
    });
  });
});
