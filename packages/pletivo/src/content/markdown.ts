/**
 * Minimal markdown parser - handles common syntax without external deps.
 * Supports: headings, paragraphs, bold, italic, code, links, images, lists, blockquotes, hr, code blocks.
 */

import yaml from "js-yaml";

export interface ParsedMarkdown {
  frontmatter: Record<string, unknown>;
  body: string;
  html: string;
}

/**
 * Parse a YAML string and narrow it to a plain object — anything else
 * (string, array, null) becomes `{}`. Uses js-yaml's default schema so
 * ISO timestamps parse to Date objects, matching Astro's frontmatter
 * behavior.
 */
export function parseYamlObject(input: string): Record<string, unknown> {
  const parsed = yaml.load(input);
  return (parsed && typeof parsed === "object" && !Array.isArray(parsed))
    ? parsed as Record<string, unknown>
    : {};
}

export function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }
  return { frontmatter: parseYamlObject(match[1]), body: match[2] };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * GitHub-style heading slugifier.
 * Lowercases, strips inline HTML tags, keeps alphanumerics + dashes,
 * collapses whitespace to single dashes.
 */
function slugify(text: string): string {
  return text
    .replace(/<[^>]+>/g, "") // strip any HTML produced by inlineMarkdown
    .toLowerCase()
    .trim()
    .replace(/[^\p{Letter}\p{Number}\s-]+/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Produce a unique slug within a single document (GitHub-style: suffix -1, -2…)
 */
function uniqueSlug(base: string, seen: Map<string, number>): string {
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

/**
 * ATX heading: 1-6 `#` followed by whitespace and at least one character of
 * content. Shared between the heading branch and the paragraph collector's
 * stop condition so the two can never disagree — a line that starts with `#`
 * but is NOT a heading (e.g. a bare `#hashtag`) must be treated as paragraph
 * text by both, otherwise the main loop fails to advance and spins forever.
 */
const HEADING_RE = /^(#{1,6})\s+(.+)$/;

/**
 * Convert markdown to HTML
 */
function markdownToHtml(md: string, seenSlugs: Map<string, number> = new Map()): string {
  const lines = md.split("\n");
  const output: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      const code = escapeHtml(codeLines.join("\n"));
      if (lang) {
        output.push(`<pre><code class="language-${lang}">${code}</code></pre>`);
      } else {
        output.push(`<pre><code>${code}</code></pre>`);
      }
      continue;
    }

    // Heading
    const headingMatch = line.match(HEADING_RE);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const inner = inlineMarkdown(headingMatch[2]);
      const slug = uniqueSlug(slugify(headingMatch[2]), seenSlugs);
      const idAttr = slug ? ` id="${slug}"` : "";
      output.push(`<h${level}${idAttr}>${inner}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(line)) {
      output.push("<hr>");
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith("> ") || line === ">") {
      const quoteLines: string[] = [];
      while (i < lines.length && (lines[i].startsWith("> ") || lines[i] === ">")) {
        quoteLines.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      output.push(`<blockquote>${markdownToHtml(quoteLines.join("\n"), seenSlugs)}</blockquote>`);
      continue;
    }

    // Unordered list
    if (/^[-*+]\s+/.test(line)) {
      output.push("<ul>");
      while (i < lines.length && /^[-*+]\s+/.test(lines[i])) {
        output.push(`<li>${inlineMarkdown(lines[i].replace(/^[-*+]\s+/, ""))}</li>`);
        i++;
      }
      output.push("</ul>");
      continue;
    }

    // Ordered list
    if (/^\d+\.\s+/.test(line)) {
      output.push("<ol>");
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        output.push(`<li>${inlineMarkdown(lines[i].replace(/^\d+\.\s+/, ""))}</li>`);
        i++;
      }
      output.push("</ol>");
      continue;
    }

    // Empty line
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Paragraph - collect consecutive non-empty lines
    const paraLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !HEADING_RE.test(lines[i]) && !lines[i].startsWith("```") && !lines[i].startsWith("> ") && !/^[-*+]\s+/.test(lines[i]) && !/^\d+\.\s+/.test(lines[i]) && !/^(\*{3,}|-{3,}|_{3,})\s*$/.test(lines[i])) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      output.push(`<p>${inlineMarkdown(paraLines.join("\n"))}</p>`);
    }
  }

  return output.join("\n");
}

/**
 * Process inline markdown (bold, italic, code, links, images)
 */
function inlineMarkdown(text: string): string {
  // Code (must be first to prevent inner processing)
  text = text.replace(/`([^`]+)`/g, (_, code) => `<code>${escapeHtml(code)}</code>`);

  // Images
  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1">');

  // Links
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Bold + italic
  text = text.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  text = text.replace(/___(.+?)___/g, "<strong><em>$1</em></strong>");

  // Bold
  text = text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/__(.+?)__/g, "<strong>$1</strong>");

  // Italic
  text = text.replace(/\*(.+?)\*/g, "<em>$1</em>");
  text = text.replace(/_(.+?)_/g, "<em>$1</em>");

  // Line breaks
  text = text.replace(/  \n/g, "<br>\n");

  return text;
}

/**
 * Parse a markdown file content into frontmatter + HTML
 */
export function parseMarkdown(content: string): ParsedMarkdown {
  const { frontmatter, body } = parseFrontmatter(content);
  const html = markdownToHtml(body.trim());
  return { frontmatter, body, html };
}
