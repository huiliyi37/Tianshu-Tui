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

function subscribe(cb: () => void) {
  // 120ms: long enough to coalesce a full drag into one trailing commit,
  // short enough to feel instant once the user lets go. Routed through the
  // shared coordinator so isResizeSettling() reflects this same drag window.
  return __subscribeTerminalSize(cb, 120)
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

// ── resize-ghost timer gate ────────────────────────────────────────────────
// The S14 debounce above only governs *resize-driven* commits. Streaming timers
// (the 1s activity tick and the 600ms GlanceBar moon animation) re-render the
// whole tree on their own schedule. If one fires mid-drag, that commit takes
// Ink's NORMAL erase path (`eraseLines(lastOutputHeight)`) at an intermediate
// width — the full-width GlanceBar rule wraps and Ink under-erases, leaving the
// stacked decreasing-width footer ghosts on shrink.
//
// `settling` is true from the first resize event of a drag until the trailing
// debounce lands. Streaming timers poll `isResizeSettling()` and skip their
// commit while it's true; the trailing resize commit then refreshes once at the
// final width. Module-level so every subscriber (app, GlanceBar) shares one flag.
let settling = false
let settleTimer: ReturnType<typeof setTimeout> | null = null

/** True while a resize drag is in flight (between first event and trailing commit). */
export function isResizeSettling(): boolean {
  return settling
}

/**
 * Attaches the shared resize coordinator: marks `settling` on the leading edge of
 * a drag, fires `cb` (and clears `settling`) on the trailing edge. Returns an
 * unsubscribe. Exported (underscore-prefixed) for tests; `subscribe` wraps it.
 */
export function __subscribeTerminalSize(cb: () => void, delayMs = 120) {
  const onResize = () => {
    settling = true
    if (settleTimer !== null) clearTimeout(settleTimer)
    settleTimer = setTimeout(() => {
      settleTimer = null
      settling = false
      cb()
    }, delayMs)
  }
  process.stdout.on('resize', onResize)
  return () => {
    if (settleTimer !== null) { clearTimeout(settleTimer); settleTimer = null }
    settling = false
    process.stdout.off('resize', onResize)
  }
}

export function useTerminalSize() {
  return useSyncExternalStore(subscribe, getTerminalSizeSnapshot)
}
