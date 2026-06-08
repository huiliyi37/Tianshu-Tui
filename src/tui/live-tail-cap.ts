import stringWidth from 'string-width'

/** Display rows a single logical line occupies at the given width (wrapping-aware). */
function rowsFor(line: string, width: number): number {
  if (width <= 0) return 1
  return Math.max(1, Math.ceil(stringWidth(line) / width))
}

function takeTailByDisplayRows(line: string, width: number, rows: number): string {
  if (rows <= 0) return ''
  if (width <= 0) return line

  const maxDisplayWidth = rows * width
  const chars = Array.from(line)
  let displayWidth = 0
  let start = chars.length

  for (let i = chars.length - 1; i >= 0; i--) {
    const nextWidth = displayWidth + stringWidth(chars[i]!)
    if (nextWidth > maxDisplayWidth) break
    displayWidth = nextWidth
    start = i
  }

  return chars.slice(start).join('')
}

/**
 * Cap the live tail to the last `maxRows` DISPLAY rows (wrapping-aware).
 *
 * The live (redrawn) region must never exceed the viewport, or Ink's relative
 * cursor-up erase clamps at the viewport top and the terminal scrolls/duplicates
 * every frame (真凶②). The bound must be in DISPLAY rows, not logical lines or
 * chars (R6): a line wider than the terminal wraps to multiple rows.
 *
 * This only trims the redrawn live region. Committed content already lives in
 * native scrollback (full, scrollable, searchable) — nothing here hides it.
 */
export function capLiveTail(text: string, width: number, maxRows: number): string {
  if (maxRows <= 0) return ''
  const lines = text.split('\n')
  let rows = 0
  const kept: string[] = []
  for (let i = lines.length - 1; i >= 0; i--) {
    const cost = rowsFor(lines[i]!, width)
    if (rows + cost > maxRows) {
      // Partial-fit the oldest kept line by trimming its head to the remaining rows.
      const remaining = maxRows - rows
      if (remaining > 0) {
        kept.unshift(takeTailByDisplayRows(lines[i]!, width, remaining))
      }
      break
    }
    rows += cost
    kept.unshift(lines[i]!)
  }
  return kept.join('\n')
}
