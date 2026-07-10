/**
 * Stream segmenter — the desktop counterpart of the TUI StreamRenderer's
 * "stable prefix + live tail" model (src/tui/engine/stream-renderer.ts).
 *
 * While a reply streams, the accumulated text is split into:
 *   - `stable` segments: frozen forever — each renders as its own memoized
 *     <Markdown> that never re-parses on subsequent deltas;
 *   - `tail`: the still-growing remainder, re-parsed per throttle tick.
 *
 * This bounds per-tick markdown cost to O(tail) instead of O(full text).
 *
 * Cut points are deliberately conservative — a wrong cut changes rendering
 * (split lists renumber, broken tables), while a missed cut only costs a
 * bigger tail. A cut is placed at the start of a COMPLETE non-blank line L
 * (partial last line never participates) when all of:
 *   - at least one blank line precedes L;
 *   - not inside a ``` / ~~~ fence, nor inside a $$ math block;
 *   - L does not start with whitespace (indented continuation / code);
 *   - NOT (previous non-blank line is a list item AND L is a list item) —
 *     cutting between items of one list turns a loose list into two lists;
 *   - the segment being closed has at least MIN_SEGMENT_CHARS (each stable
 *     segment mounts its own react component — avoid confetti).
 *
 * Frozen-prefix invariant (tested): for append-only input, previously
 * produced stable segments are returned with IDENTICAL string references
 * (===). Not required for <Markdown> memo correctness (string === compares
 * by value), but reference identity keeps the memo comparison O(1) instead
 * of an O(n) character scan per tick, and pins the no-boundary-regression
 * guarantee.
 */

export interface StreamSegments {
  /** Frozen segments, reference-stable across incremental calls. */
  stable: string[]
  /** Still-growing remainder (may be empty). */
  tail: string
}

export const EMPTY_SEGMENTS: StreamSegments = { stable: [], tail: '' }

/** Minimum size of a frozen segment — keeps component count bounded. */
export const MIN_SEGMENT_CHARS = 1000

const FENCE_RE = /^[ \t]*(?:```|~~~)/
const LIST_ITEM_RE = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:\s|$)/

/** Odd number of `$$` tokens on a line toggles display-math state
 *  (`$$` opener/closer lines toggle; single-line `$$x$$` does not). */
function togglesMathBlock(line: string): boolean {
  let count = 0
  for (let i = 0; i + 1 < line.length; i++) {
    if (line[i] === '$' && line[i + 1] === '$') {
      count++
      i++
    }
  }
  return count % 2 === 1
}

/**
 * Split `text` into stable segments + live tail. Pass the previous result to
 * resume incrementally: only the previous tail region is rescanned, and prior
 * segments are returned by reference. If `text` is not an extension of the
 * previous result (regenerate/reset), the whole text is rescanned from scratch.
 */
export function splitStableSegments(text: string, prev?: StreamSegments): StreamSegments {
  let consumed = 0
  let stable: string[] | null = null

  if (prev) {
    let ok = true
    let off = 0
    for (const seg of prev.stable) {
      if (!text.startsWith(seg, off)) { ok = false; break }
      off += seg.length
    }
    if (ok) {
      consumed = off
      stable = prev.stable
    }
  }

  const found = scan(text, consumed)
  if (found.length === 0) {
    // No new cuts. Reuse the previous object when nothing changed at all.
    if (prev && stable === prev.stable && prev.tail === text.slice(consumed)) return prev
    return { stable: stable ?? [], tail: text.slice(consumed) }
  }

  const out = stable ? stable.slice() : []
  let segStart = consumed
  for (const cut of found) {
    out.push(text.slice(segStart, cut))
    segStart = cut
  }
  return { stable: out, tail: text.slice(segStart) }
}

/** Scan complete lines in text[from..] and return absolute cut offsets. */
function scan(text: string, from: number): number[] {
  const cuts: number[] = []
  let segStart = from
  let pos = from
  let inFence = false
  let inMath = false
  let pendingBlank = false
  let prevIsListItem = false

  while (pos < text.length) {
    const nl = text.indexOf('\n', pos)
    if (nl === -1) break // last partial line — never participates in decisions
    const line = text.slice(pos, nl)

    if (inFence) {
      if (FENCE_RE.test(line)) inFence = false
      pendingBlank = false
      prevIsListItem = false
    } else if (inMath) {
      if (togglesMathBlock(line)) inMath = false
      pendingBlank = false
      prevIsListItem = false
    } else if (line.trim() === '') {
      pendingBlank = true
    } else {
      // Non-blank line outside any fence/math block: candidate cut BEFORE it.
      if (
        pendingBlank &&
        pos - segStart >= MIN_SEGMENT_CHARS &&
        line[0] !== ' ' && line[0] !== '\t' &&
        !(prevIsListItem && LIST_ITEM_RE.test(line))
      ) {
        cuts.push(pos)
        segStart = pos
      }
      pendingBlank = false
      prevIsListItem = LIST_ITEM_RE.test(line)
      if (FENCE_RE.test(line)) {
        inFence = true
        prevIsListItem = false
      } else if (togglesMathBlock(line)) {
        inMath = true
        prevIsListItem = false
      }
    }
    pos = nl + 1
  }
  return cuts
}
