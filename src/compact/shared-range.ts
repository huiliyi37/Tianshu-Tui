/**
 * Shared range utilities for staleness-detect and agent-diet.
 *
 * Both modules need to parse read_file offset/limit parameters and check
 * whether one read range contains another. These two functions were
 * duplicated verbatim across both modules — extracted here to eliminate
 * the copy-paste maintenance burden.
 */

/** Parse an optional integer from tool call args (handles both number and string). */
export function parseOptionalInt(val: unknown): number | undefined {
  if (val === undefined || val === null) return undefined
  const n = Number(val)
  if (Number.isNaN(n) || n <= 0) return undefined
  return Math.floor(n)
}

/** Check whether outer read range fully contains inner read range. */
export function rangeContains(
  outer: { offset?: number; limit?: number },
  inner: { offset?: number; limit?: number },
): boolean {
  const outerStart = outer.offset ?? 1
  const outerEnd = outer.limit !== undefined ? outerStart + outer.limit - 1 : Infinity
  const innerStart = inner.offset ?? 1
  const innerEnd = inner.limit !== undefined ? innerStart + inner.limit - 1 : Infinity
  return outerStart <= innerStart && outerEnd >= innerEnd
}
