import { tryMinifyCss } from "../../pletivo/src/css-minify.ts";

/**
 * In an Astro project `pletivo build` inlines its sheet minified and this host inlines the page's as written
 * (docs/todos/016). The head `<style>` blocks are paired in order; the first pair whose texts differ goes through
 * the Bun host's minifier and back in place, so the rest of the page is still compared byte for byte.
 */
export type InlinedStyle =
  /** No paired head `<style>` texts differ: the pages are compared as they are. */
  | { kind: "none" }
  | { kind: "minified"; expected: string; actual: string }
  /** The minifier refused one side's text, so the two cannot be compared by meaning. */
  | { kind: "rejected"; side: "pletivo build" | "this host"; log: string };

interface HeadStyle {
  start: number;
  end: number;
  css: string;
}

export async function minifyInlinedStyle(expected: string, actual: string): Promise<InlinedStyle> {
  const built = headStyles(expected);
  const rendered = headStyles(actual);
  const at = built.findIndex((style, index) => index < rendered.length && style.css !== rendered[index].css);
  if (at === -1) return { kind: "none" };
  const builtStyle = built[at];
  const renderedStyle = rendered[at];

  let builtLog = "";
  let renderedLog = "";
  const [builtCss, renderedCss] = await Promise.all([
    tryMinifyCss(builtStyle.css, (log) => {
      builtLog = log;
    }),
    tryMinifyCss(renderedStyle.css, (log) => {
      renderedLog = log;
    }),
  ]);
  if (builtCss === null) return { kind: "rejected", side: "pletivo build", log: builtLog };
  if (renderedCss === null) return { kind: "rejected", side: "this host", log: renderedLog };
  return {
    kind: "minified",
    expected: replaceStyle(expected, builtStyle, builtCss),
    actual: replaceStyle(actual, renderedStyle, renderedCss),
  };
}

/** Every plain `<style>` before `</head>`, in order: a layout's own inline block can precede the page CSS. */
function headStyles(html: string): HeadStyle[] {
  const head = html.indexOf("</head>");
  if (head === -1) return [];
  return [...html.slice(0, head).matchAll(/<style>([\s\S]*?)<\/style>/g)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    css: match[1],
  }));
}

function replaceStyle(html: string, style: HeadStyle, css: string): string {
  return `${html.slice(0, style.start)}<style>${css}</style>${html.slice(style.end)}`;
}
