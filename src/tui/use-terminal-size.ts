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
  // short enough to feel instant once the user lets go.
  const throttled = createThrottledResizeHandler(cb, 120)
  process.stdout.on('resize', throttled)
  return () => { throttled.cancel(); process.stdout.off('resize', throttled) }
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
