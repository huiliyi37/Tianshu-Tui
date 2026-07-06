/**
 * Normalize markdown source before frontmatter parsing.
 *
 * All frontmatter parsers in this repo match `/^---\n…\n---\n/` — an LF-only
 * assumption. On Windows the same files arrive with CRLF (git autocrlf
 * checkout, desktop editors) and often a UTF-8 BOM (Notepad), which made every
 * `.rivet/skills/` skill fail with "missing YAML frontmatter" on the desktop
 * build. Strip the BOM and fold CRLF / lone CR to LF once at the parse entry
 * instead of sprinkling `\r?` through every regex.
 */
export function normalizeFrontmatterSource(content: string): string {
  return content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
}
