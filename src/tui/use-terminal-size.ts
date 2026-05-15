import { useSyncExternalStore } from 'react'

export interface TerminalSizeSnapshot {
  rows: number
  columns: number
}

let cachedSnapshot: TerminalSizeSnapshot | undefined

function subscribe(cb: () => void) {
  process.stdout.on('resize', cb)
  return () => { process.stdout.off('resize', cb) }
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
