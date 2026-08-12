/** Turn wire ids (`search_database`, `mcp__foo`) into readable labels. */
export function idToReadableText(
  id: string,
  options: { capitalize?: boolean } = {}
): string {
  const capitalize = options.capitalize !== false;
  const spaced = id
    .replace(/^mcp__/i, "")
    .replace(/[_./-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!spaced) return id;
  if (!capitalize) return spaced;
  return spaced.replace(/\b\w/g, (ch) => ch.toUpperCase());
}
