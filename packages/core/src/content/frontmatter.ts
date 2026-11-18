/** Split off a YAML frontmatter block without parsing it. `yaml` is null when there is none. */
export function splitFrontmatter(content: string): { yaml: string | null; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return { yaml: null, body: content };
  }
  return { yaml: match[1], body: match[2] };
}
