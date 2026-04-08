/**
 * Minimal markdown parser - handles common syntax without external deps.
 * Supports: headings, paragraphs, bold, italic, code, links, images, lists, blockquotes, hr, code blocks.
 */

export interface ParsedMarkdown {
  frontmatter: Record<string, unknown>;
  body: string;
  html: string;
}

/**
 * Extract YAML frontmatter from markdown content
 */
function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const yamlStr = match[1];
  const body = match[2];
  const frontmatter: Record<string, unknown> = {};

  // Simple YAML parser for flat key-value pairs and arrays
  const lines = yamlStr.split("\n");
  let currentKey = "";
  let currentArray: string[] | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Array item
    if (trimmed.startsWith("- ") && currentKey) {
      if (!currentArray) {
        currentArray = [];
        frontmatter[currentKey] = currentArray;
      }
      currentArray.push(trimmed.slice(2).trim().replace(/^["']|["']$/g, ""));
      continue;
    }

    // Key-value pair
    const kvMatch = trimmed.match(/^(\w[\w-]*)\s*:\s*(.*)$/);
    if (kvMatch) {
      currentKey = kvMatch[1];
      currentArray = null;
      let value: unknown = kvMatch[2].trim();

      if (value === "") {
        // Could be start of an array
        continue;
      }

      // Remove quotes
      if (typeof value === "string" && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
        value = value.slice(1, -1);
      }
      // Inline array: [a, b, c]
      else if (typeof value === "string" && value.startsWith("[") && value.endsWith("]")) {
        value = value.slice(1, -1).split(",").map(s => s.trim().replace(/^["']|["']$/g, ""));
      }
      // Booleans
      else if (value === "true") value = true;
      else if (value === "false") value = false;
      // Numbers
      else if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) {
        value = Number(value);
      }

      frontmatter[currentKey] = value;
    }
  }

  return { frontmatter, body };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Convert markdown to HTML
 */
function markdownToHtml(md: string): string {
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
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      output.push(`<h${level}>${inlineMarkdown(headingMatch[2])}</h${level}>`);
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
      output.push(`<blockquote>${markdownToHtml(quoteLines.join("\n"))}</blockquote>`);
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
    while (i < lines.length && lines[i].trim() !== "" && !lines[i].startsWith("#") && !lines[i].startsWith("```") && !lines[i].startsWith("> ") && !/^[-*+]\s+/.test(lines[i]) && !/^\d+\.\s+/.test(lines[i]) && !/^(\*{3,}|-{3,}|_{3,})\s*$/.test(lines[i])) {
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
