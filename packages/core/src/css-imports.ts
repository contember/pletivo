/** CSS `@import` discovery shared by `pletivo prepare` and the Workers host. */

/**
 * The targets of a stylesheet's `@import` rules, in source order. A tokenizer, not a
 * search: an `@import` inside a comment or a string is no import. `url()` references
 * elsewhere in the sheet are assets, not imports, and are not returned.
 */
export function cssImports(source: string): string[] {
  const imports: string[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    cursor = skipCssTrivia(source, cursor);
    if (cursor >= source.length) break;
    if (source[cursor] !== "@" || source.slice(cursor + 1, cursor + 7).toLowerCase() !== "import") {
      cursor = skipCssToken(source, cursor);
      continue;
    }
    const boundary = source[cursor + 7];
    if (boundary !== undefined && /[A-Za-z0-9_-]/.test(boundary)) {
      cursor += 7;
      continue;
    }
    cursor = skipCssTrivia(source, cursor + 7);
    const parsed = readCssImportTarget(source, cursor);
    if (parsed) {
      imports.push(parsed.value);
      cursor = parsed.end;
    } else {
      cursor = skipCssToken(source, cursor);
    }
  }
  return imports;
}

interface CssValue {
  value: string;
  end: number;
}

function readCssImportTarget(source: string, cursor: number): CssValue | null {
  const quote = source[cursor];
  if (quote === "\"" || quote === "'") return readCssString(source, cursor, quote);
  if (source.slice(cursor, cursor + 3).toLowerCase() !== "url") return null;
  let at = skipCssTrivia(source, cursor + 3);
  if (source[at] !== "(") return null;
  at = skipCssTrivia(source, at + 1);
  const innerQuote = source[at];
  if (innerQuote === "\"" || innerQuote === "'") {
    const parsed = readCssString(source, at, innerQuote);
    if (!parsed) return null;
    const closing = skipCssTrivia(source, parsed.end);
    return source[closing] === ")" ? { value: parsed.value, end: closing + 1 } : null;
  }
  let raw = "";
  while (at < source.length && source[at] !== ")") {
    if (source.startsWith("/*", at)) return null;
    if (/\s/.test(source[at])) {
      const closing = skipCssTrivia(source, at);
      return source[closing] === ")"
        ? { value: decodeCssEscapes(raw), end: closing + 1 }
        : null;
    }
    if (source[at] === "\\" && at + 1 < source.length) {
      const hex = /^[0-9a-fA-F]{1,6}/.exec(source.slice(at + 1));
      if (!hex) {
        raw += source.slice(at, at + 2);
        at += 2;
        continue;
      }
      const whitespace = /\s/.test(source[at + 1 + hex[0].length] ?? "") ? 1 : 0;
      const end = at + 1 + hex[0].length + whitespace;
      raw += source.slice(at, end);
      at = end;
      continue;
    }
    raw += source[at];
    at++;
  }
  return source[at] === ")" && raw.length > 0
    ? { value: decodeCssEscapes(raw), end: at + 1 }
    : null;
}

function readCssString(source: string, cursor: number, quote: string): CssValue | null {
  let raw = "";
  for (let at = cursor + 1; at < source.length; at++) {
    const char = source[at];
    if (char === quote) return { value: decodeCssEscapes(raw), end: at + 1 };
    if (char === "\n" || char === "\r") return null;
    if (char === "\\" && at + 1 < source.length) {
      raw += source.slice(at, at + 2);
      at++;
      continue;
    }
    raw += char;
  }
  return null;
}

function skipCssTrivia(source: string, cursor: number): number {
  let at = cursor;
  while (at < source.length) {
    if (/\s/.test(source[at])) {
      at++;
      continue;
    }
    if (source.startsWith("/*", at)) {
      const end = source.indexOf("*/", at + 2);
      return end === -1 ? source.length : skipCssTrivia(source, end + 2);
    }
    break;
  }
  return at;
}

function skipCssToken(source: string, cursor: number): number {
  if (source.startsWith("/*", cursor)) return skipCssTrivia(source, cursor);
  const quote = source[cursor];
  if (quote === "\"" || quote === "'") return readCssString(source, cursor, quote)?.end ?? source.length;
  if (source[cursor] === "\\") return Math.min(cursor + 2, source.length);
  return cursor + 1;
}

function decodeCssEscapes(value: string): string {
  let decoded = "";
  for (let at = 0; at < value.length; at++) {
    if (value[at] !== "\\") {
      decoded += value[at];
      continue;
    }
    at++;
    if (at >= value.length) break;
    if (value[at] === "\n") continue;
    if (value[at] === "\r") {
      if (value[at + 1] === "\n") at++;
      continue;
    }
    const hex = /^[0-9a-fA-F]{1,6}/.exec(value.slice(at));
    if (!hex) {
      decoded += value[at];
      continue;
    }
    const codePoint = Number.parseInt(hex[0], 16);
    decoded += String.fromCodePoint(codePoint === 0 || codePoint > 0x10ffff ? 0xfffd : codePoint);
    at += hex[0].length - 1;
    if (/\s/.test(value[at + 1] ?? "")) at++;
  }
  return decoded;
}
