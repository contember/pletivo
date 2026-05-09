import { describe, expect, test } from "bun:test";
import { experimental_AstroContainer } from "../../packages/pletivo/src/runtime/astro-container";
import { createComponent } from "../../packages/pletivo/src/runtime/astro-shim";

describe("experimental_AstroContainer", () => {
  test("create() returns an instance", async () => {
    const container = await experimental_AstroContainer.create();
    expect(container).toBeInstanceOf(experimental_AstroContainer);
  });

  test("renderToString() with a static component returns its HTML", async () => {
    const Component = createComponent(
      async () => ({ __html: "<p>hello</p>" }),
      "src/components/Hello.astro",
    );
    const container = await experimental_AstroContainer.create();
    const html = await container.renderToString(Component);
    expect(html).toBe("<p>hello</p>");
  });

  test("renderToString() forwards props to the component", async () => {
    const Component = createComponent(
      async (_result, props) => ({ __html: `<p>name=${String(props.name ?? "")}</p>` }),
      "src/components/Greeter.astro",
    );
    const container = await experimental_AstroContainer.create();
    const html = await container.renderToString(Component, { props: { name: "world" } });
    expect(html).toBe("<p>name=world</p>");
  });

  test("renderToString() rejects non-function components", async () => {
    const container = await experimental_AstroContainer.create();
    await expect(container.renderToString("not-a-component" as unknown))
      .rejects.toThrow(/AstroComponentFactory/);
  });

  test("renderToString() rejects unsupported slots", async () => {
    const Component = createComponent(
      async () => ({ __html: "<p>x</p>" }),
      "src/components/X.astro",
    );
    const container = await experimental_AstroContainer.create();
    await expect(container.renderToString(Component, { slots: { default: "x" } }))
      .rejects.toThrow(/slots/);
  });

  test("renderToResponse() returns a text/html Response", async () => {
    const Component = createComponent(
      async () => ({ __html: "<h1>hi</h1>" }),
      "src/components/Hi.astro",
    );
    const container = await experimental_AstroContainer.create();
    const response = await container.renderToResponse(Component);
    expect(response).toBeInstanceOf(Response);
    expect(response.headers.get("content-type")).toBe("text/html");
    expect(await response.text()).toBe("<h1>hi</h1>");
  });
});
