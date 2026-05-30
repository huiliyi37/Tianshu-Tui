import { useSyncExternalStore } from 'react'

export interface TerminalSizeSnapshot {
  rows: number
  columns: number
}

let cachedSnapshot: TerminalSizeSnapshot | undefined

type ThrottledHandler = (() => void) & { cancel: () => void }

export function createThrottledResizeHandler(cb: () => void, delayMs: number): ThrottledHandler {
  let last = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  const handler = (() => {
    const now = Date.now()
    if (now - last >= delayMs) {
      last = now
      cb()
    } else if (timer === null) {
      timer = setTimeout(() => {
        timer = null
        last = Date.now()
        cb()
      }, delayMs - (now - last))
    }
  }) as ThrottledHandler
  handler.cancel = () => { if (timer !== null) { clearTimeout(timer); timer = null } }
  return handler
}

function subscribe(cb: () => void) {
  const throttled = createThrottledResizeHandler(cb, 32)
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
