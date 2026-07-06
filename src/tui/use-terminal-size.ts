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
const settleListeners = new Set<() => void>()
let resizeClear: (() => void) | null = null
let stdoutBound = false

/** True while a resize drag is in flight (between first event and trailing commit). */
export function isResizeSettling(): boolean {
  return settling
}

// Reactive mirror of `settling` for useSyncExternalStore. A plain boolean can't
// drive a React re-render; this snapshot flips with `settling` and notifies
// subscribers so the live region can collapse for the duration of the drag.
let settlingSnapshot = false
function setSettling(next: boolean) {
  if (settling === next) return
  settling = next
  settlingSnapshot = next
  for (const cb of settleListeners) cb()
}

function subscribeSettling(cb: () => void) {
  settleListeners.add(cb)
  bindStdout()
  return () => {
    settleListeners.delete(cb)
    unbindStdoutIfIdle()
  }
}

/** Test hook: subscribe to settling-flag transitions (wraps subscribeSettling). */
export function __subscribeSettling(cb: () => void) {
  return subscribeSettling(cb)
}

/**
 * Reactive resize-settling flag. While true, the caller should collapse the
 * LIVE region (streaming tail, thinking, tools, heartbeat) to near-nothing.
 *
 * Why: Ink's resized() (ink.js) re-lays-out and re-renders the EXISTING React
 * tree SYNCHRONOUSLY on every 'resize' event — before React can reconcile a
 * shrunk tree. On width-shrink the same text wraps to more rows, so a tall live
 * frame can reach terminal height and trip Ink's fullscreen re-emit
 * (`\x1B[2J\x1B[H + fullStaticOutput`), which on macOS terminals scrolls a copy
 * into scrollback every frame (= the stacked/duplicated lines). We can't win the
 * ordering race, so instead we keep the live tree SHORT for the whole drag: a
 * short frame can't overflow no matter how Ink reflows it. One clean commit
 * follows on the trailing edge. See [[resize-ghost-streaming-timer-bypass]].
 */
export function useResizeSettling(): boolean {
  return useSyncExternalStore(subscribeSettling, () => settlingSnapshot, () => false)
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
  setSettling(true)
  // Notify size subscribers so the live-region cap recomputes at the new size.
  // The reactive settling flag (above) collapses the live region for the drag,
  // so even though Ink's resized() renders the tree synchronously first, that
  // tree is already short and can't overflow into fullscreen mode.
  for (const cb of listeners) cb()
  // Trailing edge: after the drag settles, clear any under-erase residue (Ink
  // only clears on width-decrease) and commit the full live region once more
  // onto a clean screen.
  if (settleTimer !== null) clearTimeout(settleTimer)
  settleTimer = setTimeout(() => {
    settleTimer = null
    setSettling(false)
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
  if (stdoutBound && listeners.size === 0 && settleListeners.size === 0) {
    process.stdout.off('resize', onResize)
    stdoutBound = false
    if (settleTimer !== null) { clearTimeout(settleTimer); settleTimer = null }
    setSettling(false)
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
