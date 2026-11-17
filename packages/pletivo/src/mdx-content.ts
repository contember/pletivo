/**
 * The default export of a compiled `.mdx` module. pletivo renders MDX itself, so the runtime
 * never offers it to a framework renderer. Astro writes the scripts of the content's islands
 * at the start of the content, ahead of the first element, so they are hoisted here.
 */
import { hoistIslandScripts } from "@pletivo/runtime/astro-islands/index";
import { markNativeComponent } from "@pletivo/runtime/astro-islands/native";
import { createHtml, isHtmlString } from "@pletivo/runtime/html-string";

type MdxContent = (props?: Record<string, unknown>) => unknown;

function hoisted(rendered: unknown): unknown {
  return isHtmlString(rendered) ? createHtml(hoistIslandScripts(rendered.__html)) : rendered;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * `defaultComponents`, set in an Astro project, go to `MDXContent` under the caller's
 * `components`, as `@astrojs/mdx`'s `Content` passes them.
 */
export function mdxContent(
  render: MdxContent,
  defaultComponents?: Record<string, unknown>,
): (props?: Record<string, unknown>) => unknown {
  return markNativeComponent(function MDXContent(props?: Record<string, unknown>): unknown {
    const given = props?.components;
    const rendered = defaultComponents
      ? render({ ...props, components: { ...defaultComponents, ...(isRecord(given) ? given : {}) } })
      : render(props);
    return rendered instanceof Promise ? rendered.then(hoisted) : hoisted(rendered);
  });
}
