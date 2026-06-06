import type { LogEntry } from './log-state.js'

/**
 * Monotonic, append-only committed log feeding Ink's <Static> component.
 *
 * Why this exists (真凶①): app.tsx previously fed <Static> the result of
 * `historyItems.slice(start)` where `start = max(0, totalItemsPushed - length)`.
 * Once the ring buffer wrapped (capped at 5000), `length` stopped growing while
 * the counter kept climbing, so the sliced array SHRANK render-to-render. Ink's
 * <Static> tracks an internal high-water `index` against `items.length`; a
 * shrinking/prefix-shifting array desyncs that index, causing already-committed
 * lines to be re-emitted (duplication) or new lines to be skipped (silent loss —
 * see docs/.../2026-06-01-static-sliding-window-bug.md).
 *
 * The fix: the array handed to <Static> must be append-only and prefix-stable.
 * Ink's index is an array INDEX, so as long as we never remove or reorder earlier
 * elements, the index can never desync. Memory is reclaimed by emptying the
 * `content` of already-rendered entries (releaseRendered) — NOT by removing them,
 * which would shift indices.
 */
export interface CommittedLog {
  /** Append an entry. Deduped by entry id over a rolling window (256 ids).
   *  Returns true if appended, false if a duplicate was skipped. */
  append(entry: LogEntry): boolean
  /** The array to feed <Static items={...}>. Only grows; never shrinks or reorders. */
  items(): readonly LogEntry[]
  /** Reclaim memory: empty the `content` of entries before (length - keepLast),
   *  preserving id/type for stable React memo keys. Safe because Static only
   *  renders items.slice(index); released entries are below that index.
   *  keepLast covers entries that may still be mid-render. */
  releaseRendered(keepLast: number): void
  /** Number of entries appended (monotonic; equals items().length). */
  readonly length: number
  /** Hard reset — ONLY for rewind (an explicit clear-and-redraw). Not part of
   *  the steady-state append-only invariant. */
  reset(): void
}

export function createCommittedLog(): CommittedLog {
  const arr: LogEntry[] = []
  let dedup = new Set<string>()
  const MAX_DEDUP = 256
  // CRITICAL: Ink 6.8's <Static> memoizes `items.slice(index)` keyed on the items
  // REFERENCE (node_modules/ink/build/components/Static.js:12 — `useMemo(() =>
  // items.slice(index), [items, index])`). If items() returns the SAME array
  // reference after we append (mutate in place), that memo never invalidates and
  // newly-appended entries are NEVER rendered — the entire conversation silently
  // fails to appear in scrollback (reply lives only in the live region, then
  // "vanishes" when committed). So items() must return a NEW reference whenever the
  // log changes. We cache the snapshot so repeated items() calls BETWEEN mutations
  // return the same reference (one copy per change, not per call) — that stability
  // is what keeps Ink's high-water `index` from desyncing (the original 真凶① goal),
  // while the change-on-mutation is what makes new entries actually render.
  let snapshot: readonly LogEntry[] | null = null

  return {
    append(entry: LogEntry): boolean {
      const id = entry.id
      if (dedup.has(id)) return false
      dedup.add(id)
      if (dedup.size > MAX_DEDUP) {
        // Rotate: keep last 128 (half window) to bound memory while preserving
        // reasonable window for streaming chunked commits (~dozens per turn).
        const recent = [...dedup].slice(-128)
        dedup.clear()
        for (const r of recent) dedup.add(r)
        dedup.add(id)
      }
      arr.push(entry)
      snapshot = null // reference must change so Ink's <Static> memo re-renders
      return true
    },
    items(): readonly LogEntry[] {
      if (snapshot === null) snapshot = arr.slice()
      return snapshot
    },
    releaseRendered(keepLast: number): void {
      const cutoff = arr.length - Math.max(0, keepLast)
      let changed = false
      for (let i = 0; i < cutoff; i++) {
        const e = arr[i]!
        if (e.content !== '') {
          // Mutate in place: empty heavy content, keep id/type for stable memo key.
          arr[i] = { ...e, content: '' }
          changed = true
        }
      }
      if (changed) snapshot = null
    },
    get length(): number {
      return arr.length
    },
    reset(): void {
      arr.length = 0
      dedup = new Set()
      snapshot = null
    },
  }
}
