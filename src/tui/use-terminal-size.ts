import { useSyncExternalStore } from 'react'

function subscribe(cb: () => void) {
  process.stdout.on('resize', cb)
  return () => { process.stdout.off('resize', cb) }
}

function getSnapshot() {
  return { rows: process.stdout.rows ?? 40, columns: process.stdout.columns ?? 80 }
}

export function useTerminalSize() {
  return useSyncExternalStore(subscribe, getSnapshot)
}
