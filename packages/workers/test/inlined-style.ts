import { minifyCss } from "../../pletivo/src/css-minify.ts";

/**
 * In an Astro project `pletivo build` inlines its sheet minified and this host inlines the page's as written
 * (docs/todos/016). Both head `<style>` texts go through the Bun host's minifier and back in place, so the
 * rest of the page, the minified CSS included, is still compared byte for byte.
 */
export type InlinedStyle =
  /** No head `<style>` on the build's side, or the same text on both: compared as it is. */
  | { kind: "none" }
  /** The build inlined a head `<style>` and this host did not. */
  | { kind: "missing" }
  | { kind: "minified"; expected: string; actual: string; built: SheetDelta; rendered: SheetDelta };

/** Reported so a reader can see the minifier dropped or merged no rule. */
export interface SheetDelta {
  bytes: number;
  blocks: number;
  minifiedBytes: number;
  minifiedBlocks: number;
}

interface HeadStyle {
  start: number;
  end: number;
  css: string;
}

export async function minifyInlinedStyle(expected: string, actual: string): Promise<InlinedStyle> {
  const built = headStyle(expected);
  if (built === null) return { kind: "none" };
  const rendered = headStyle(actual);
  if (rendered === null) return { kind: "missing" };
  // Equal text needs no minifier; this keeps a scoped-only block that matches compared raw.
  if (built.css === rendered.css) return { kind: "none" };
  const [builtCss, renderedCss] = await Promise.all([minifyCss(built.css), minifyCss(rendered.css)]);
  return {
    kind: "minified",
    expected: replaceStyle(expected, built, builtCss),
    actual: replaceStyle(actual, rendered, renderedCss),
    built: delta(built.css, builtCss),
    rendered: delta(rendered.css, renderedCss),
  };
}

export function describeDelta(sheet: SheetDelta): string {
  const before = `${sheet.bytes} B/${sheet.blocks} block(s)`;
  if (sheet.bytes === sheet.minifiedBytes && sheet.blocks === sheet.minifiedBlocks) return `${before} unchanged`;
  return `${before} → ${sheet.minifiedBytes} B/${sheet.minifiedBlocks} block(s)`;
}

/** The first plain `<style>` before `</head>`, where both hosts put the page's CSS. */
function headStyle(html: string): HeadStyle | null {
  const head = html.indexOf("</head>");
  if (head === -1) return null;
  const match = /<style>([\s\S]*?)<\/style>/.exec(html.slice(0, head));
  if (match === null) return null;
  return { start: match.index, end: match.index + match[0].length, css: match[1] };
}

function replaceStyle(html: string, style: HeadStyle, css: string): string {
  return `${html.slice(0, style.start)}<style>${css}</style>${html.slice(style.end)}`;
}

function delta(css: string, minified: string): SheetDelta {
  return {
    bytes: Buffer.byteLength(css),
    blocks: blockCount(css),
    minifiedBytes: Buffer.byteLength(minified),
    minifiedBlocks: blockCount(minified),
  };
}

/** Comments are stripped first: a label like the Workers host's could hold a brace. */
function blockCount(css: string): number {
  return css.replace(/\/\*[\s\S]*?\*\//g, "").split("{").length - 1;
}
