import { useSyncExternalStore } from 'react'

export interface TerminalSizeSnapshot {
  rows: number
  columns: number
}

let cachedSnapshot: TerminalSizeSnapshot | undefined

type ThrottledHandler = (() => void) & { cancel: () => void }

/**
 * Trailing-edge debounce for resize events (S14 → resize-ghost fix).
 *
 * Why debounce, not leading-edge throttle: Ink 6.8 already owns a resize
 * listener that clears the screen on width-decrease (ink.js `resized()`).
 * If we *also* push React re-renders mid-drag, those commits take Ink's
 * NORMAL render path (`eraseLines(lastOutputHeight)`) with a height that's
 * stale after the terminal reflowed wide lines at the new width → each tick
 * leaves an un-erased frame = the stacked-footer ghosts on shrink.
 *
 * Firing only on the trailing edge means we commit exactly once, after the
 * drag settles, while Ink's own handler keeps the screen clean during it.
 */
export function createThrottledResizeHandler(cb: () => void, delayMs: number): ThrottledHandler {
  let timer: ReturnType<typeof setTimeout> | null = null
  const handler = (() => {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => { timer = null; cb() }, delayMs)
  }) as ThrottledHandler
  handler.cancel = () => { if (timer !== null) { clearTimeout(timer); timer = null } }
  return handler
}

// ── shared resize coordinator ──────────────────────────────────────────────
// ONE process.stdout 'resize' listener fans out to all React subscribers, so a
// drag produces a single coalesced commit no matter how many components use the
// hook. Two responsibilities:
//
//  1. `settling` flag — true from a drag's first event until the trailing edge.
//     Streaming timers (1s activity tick, 600ms moon animation, 2Hz fluency)
//     poll isResizeSettling() and skip their commit while true, so they never
//     push a mid-drag frame at an intermediate width.
//
//  2. resize-clear — Ink's own resized() (ink.js) ONLY clears the screen when
//     width *decreases*; on width *increase* it diffs the new frame against
//     lastOutput computed at the narrow width, where line-wrapping differed, and
//     the orphaned physical rows of the old frame persist as ghosts (two stacked
//     ground zones, even idle). We register a clear hook (main.tsx wires Ink's
//     instance.clear) and fire it on the trailing edge for EITHER direction
//     before the commit, wiping any under-erase residue.
let settling = false
let settleTimer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()
let resizeClear: (() => void) | null = null
let stdoutBound = false

/** True while a resize drag is in flight (between first event and trailing commit). */
export function isResizeSettling(): boolean {
  return settling
}

/**
 * Registers the screen-clear to run on a resize trailing edge (direction-
 * independent), compensating for Ink only clearing on width-decrease. main.tsx
 * passes Ink's `instance.clear`. Returns an unregister.
 */
export function registerResizeClear(clear: () => void): () => void {
  resizeClear = clear
  return () => { if (resizeClear === clear) resizeClear = null }
}

const SETTLE_MS = 120 // trailing edge: coalesce the end of a drag into one clear+commit

function onResize() {
  settling = true
  // IMMEDIATE notify on every resize event — NOT debounced. The live-region
  // height cap (capLiveTail in app.tsx) recomputes only when React re-renders;
  // if we defer the re-render to the trailing edge, Ink's own resized() re-lays
  // out the existing (old-size-capped) elements at the new smaller height first,
  // overflowing the viewport and tripping Ink's fullscreen re-emit (whole history
  // dumped to scrollback = duplicated conversation). getTerminalSizeSnapshot()
  // caches by rows/cols, so useSyncExternalStore bails out when size is unchanged
  // — notifying per-event is cheap and only re-renders on a real size change.
  for (const cb of listeners) cb()
  // Trailing edge: after the drag settles, clear under-erase residue (Ink only
  // clears on width-decrease) and commit once more onto a clean screen.
  if (settleTimer !== null) clearTimeout(settleTimer)
  settleTimer = setTimeout(() => {
    settleTimer = null
    settling = false
    if (resizeClear) resizeClear()
    for (const cb of listeners) cb()
  }, SETTLE_MS)
}

function bindStdout() {
  if (stdoutBound) return
  process.stdout.on('resize', onResize)
  stdoutBound = true
}

function unbindStdoutIfIdle() {
  if (stdoutBound && listeners.size === 0) {
    process.stdout.off('resize', onResize)
    stdoutBound = false
    if (settleTimer !== null) { clearTimeout(settleTimer); settleTimer = null }
    settling = false
  }
}

/**
 * Subscribe to coalesced resize commits. Exported (underscore-prefixed) for
 * tests; `subscribe` (the React hook's store subscriber) wraps it.
 */
export function __subscribeTerminalSize(cb: () => void) {
  listeners.add(cb)
  bindStdout()
  return () => {
    listeners.delete(cb)
    unbindStdoutIfIdle()
  }
}

function subscribe(cb: () => void) {
  return __subscribeTerminalSize(cb)
}

export function getTerminalSizeSnapshot(): TerminalSizeSnapshot {
  const rows = process.stdout.rows ?? 40
  const columns = process.stdout.columns ?? 80
  if (cachedSnapshot?.rows === rows && cachedSnapshot.columns === columns) {
    return cachedSnapshot
  }
  cachedSnapshot = { rows, columns }
  return cachedSnapshot
}

export function useTerminalSize() {
  return useSyncExternalStore(subscribe, getTerminalSizeSnapshot)
}
