/**
 * Shim for `astro/container` — the experimental Container API that lets
 * integrations render `.astro` components from outside the page render
 * pipeline (typically from `astro:build:done` hooks).
 *
 * Pletivo's compiled `.astro` modules export an `AstroComponentFactory`
 * (see `astro-shim.ts`) that, when called as `Component(props)`, produces
 * `Promise<HtmlString>`. We expose that contract under Astro's container
 * shape:
 *
 *     import { experimental_AstroContainer } from "astro/container";
 *     const container = await experimental_AstroContainer.create();
 *     const html = await container.renderToString(Component, { props });
 *
 * Astro's full Container API supports slots, partials, locals, request
 * objects, etc. — pletivo's shim covers the pragmatic subset that
 * post-build integrations actually use (component + props → HTML).
 * Anything else throws so misuse fails loudly rather than silently
 * producing wrong output.
 */

import type { AstroComponentFactory, HtmlString } from "./astro-shim";

export interface RenderOptions {
  props?: Record<string, unknown>;
  slots?: Record<string, unknown>;
}

export class experimental_AstroContainer {
  private constructor() {}

  static async create(): Promise<experimental_AstroContainer> {
    return new experimental_AstroContainer();
  }

  async renderToString(
    component: AstroComponentFactory | unknown,
    options: RenderOptions = {},
  ): Promise<string> {
    if (typeof component !== "function") {
      throw new Error(
        "experimental_AstroContainer.renderToString: component must be an AstroComponentFactory (compiled .astro module default export).",
      );
    }
    if (options.slots && Object.keys(options.slots).length > 0) {
      throw new Error(
        "experimental_AstroContainer.renderToString: slots are not yet supported by pletivo's container shim.",
      );
    }
    const result = await (component as (
      props: Record<string, unknown>,
    ) => Promise<HtmlString | string> | HtmlString | string)(
      options.props ?? {},
    );
    if (typeof result === "string") return result;
    if (result && typeof result === "object" && "__html" in result) {
      return (result as HtmlString).__html;
    }
    throw new Error(
      `experimental_AstroContainer.renderToString: component returned an unexpected value of type ${typeof result}; expected string or HtmlString.`,
    );
  }

  async renderToResponse(
    component: AstroComponentFactory | unknown,
    options: RenderOptions = {},
  ): Promise<Response> {
    const html = await this.renderToString(component, options);
    return new Response(html, {
      headers: { "Content-Type": "text/html" },
    });
  }
}
