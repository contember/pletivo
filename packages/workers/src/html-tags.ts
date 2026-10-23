/**
 * The tags of a rendered page, as far as finding `</head>`, `<body>` and `<script src>`
 * needs. Comments, `<!…>` and `<?…>` are skipped, and so is the content of `<script>`,
 * `<style>`, `<textarea>`, `<title>` and `<template>`. Not a full tokenizer: a nested
 * `<template>` ends at the first `</template>`, and malformed markup is read loosely.
 */

export interface HtmlTag {
  /** Lower-cased. */
  name: string;
  closing: boolean;
  /** Offset of the tag's `<`. */
  start: number;
  /** The tag's source, `<` to `>`. */
  source: string;
}

const TAG = /<(\/?)([A-Za-z][^\s/>]*)(?:[^>"']|"[^"]*"|'[^']*')*>/y;

/** Elements whose content is not markup, so a `</head>` inside one is text. */
const OPAQUE_CONTENT = new Set(["script", "style", "textarea", "title", "template"]);

export function* htmlTags(html: string): Generator<HtmlTag> {
  let at = 0;
  while (true) {
    const open = html.indexOf("<", at);
    if (open === -1) return;
    if (html.startsWith("<!--", open)) {
      const end = html.indexOf("-->", open + 4);
      if (end === -1) return;
      at = end + 3;
      continue;
    }
    if (html[open + 1] === "!" || html[open + 1] === "?") {
      const end = html.indexOf(">", open);
      if (end === -1) return;
      at = end + 1;
      continue;
    }
    TAG.lastIndex = open;
    const match = TAG.exec(html);
    if (match === null) {
      at = open + 1;
      continue;
    }
    const name = (match[2] ?? "").toLowerCase();
    const closing = match[1] === "/";
    yield { name, closing, start: open, source: match[0] };
    at = open + match[0].length;
    if (closing || !OPAQUE_CONTENT.has(name)) continue;
    const end = new RegExp(`</${name}[\\s/>]`, "gi");
    end.lastIndex = at;
    const found = end.exec(html);
    if (found === null) return;
    at = found.index;
  }
}

/** An attribute's value as written in `tag`, entities left as they are; `null` when absent. */
export function attributeValue(tag: HtmlTag, name: string): string | null {
  const pattern = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
  const match = pattern.exec(tag.source);
  if (match === null) return null;
  return match[1] ?? match[2] ?? match[3] ?? "";
}
