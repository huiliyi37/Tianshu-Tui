/**
 * Shared separator / horizontal-rule helpers for TUI visual hierarchy.
 * Pure string functions — no Ink dependency.
 */

export type SeparatorStyle = 'thin' | 'thick' | 'dots'

const CHARS: Record<SeparatorStyle, string> = {
  thin: '─',
  thick: '━',
  dots: '┄',
}

/**
 * Generate a horizontal rule string capped to `maxWidth` (default 72).
 * Intentionally shorter than full terminal width to avoid visual noise
 * on ultra-wide terminals while still providing clear separation.
 */
export function horizontalRule(
  terminalColumns: number,
  style: SeparatorStyle = 'thin',
  maxWidth = 72,
): string {
  const width = Math.max(20, Math.min(terminalColumns - 4, maxWidth))
  return CHARS[style].repeat(width)
}
