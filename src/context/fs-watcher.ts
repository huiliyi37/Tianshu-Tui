import { watch, type FSWatcher } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

export interface FsWatcherConfig {
  /** Directory to watch (project root). Only top-level entries are watched. */
  cwd: string
  /** Event rate window in ms (default: 60_000 = 1 minute) */
  windowMs?: number
  /** Debounce: ignore events within ms of previous (default: 2000) */
  debounceMs?: number
}

export interface FsWatcherState {
  /** Events per minute in the current window */
  eventRate: number
  /** Total events in current window */
  eventCount: number
  /** Whether watcher is active */
  active: boolean
}

/**
 * 原则 ③ 参考系锚定 — 外部 Zeitgeber
 *
 * Watches top-level entries in the project directory.
 * recursive: false avoids node_modules / .git overhead.
 * Debounced to filter rapid save-all bursts (< 2s between events).
 *
 * Usage:
 *   const watcher = createFsWatcher({ cwd: projectRoot })
 *   watcher.start()
 *   // later...
 *   const { eventRate } = watcher.getState()  // 0.0–1.0 normalized
 *   watcher.stop()
 */
export function createFsWatcher(config: FsWatcherConfig) {
  const windowMs = config.windowMs ?? 60_000
  const debounceMs = config.debounceMs ?? 2_000

  let fsWatcher: FSWatcher | undefined
  let events: number[] = []
  let lastEventTime = 0

  function recordEvent(): void {
    const now = Date.now()
    if (now - lastEventTime < debounceMs) return
    lastEventTime = now
    events.push(now)
  }

  function pruneOld(now: number): void {
    events = events.filter(t => now - t <= windowMs)
  }

  function getState(): FsWatcherState {
    const now = Date.now()
    pruneOld(now)
    const eventCount = events.length
    // Normalize: 0 events = 0, ≥30 events/min = 1.0 (high volatility)
    const eventRate = Math.min(1, eventCount / 30)
    return {
      eventRate,
      eventCount,
      active: fsWatcher !== undefined,
    }
  }

  async function start(): Promise<void> {
    if (fsWatcher) return
    try {
      // Only watch top-level entries — recursive: false
      fsWatcher = watch(config.cwd, { recursive: false }, () => {
        recordEvent()
      })
      // Also watch immediate subdirectories (src/, docs/, etc.) for deeper coverage
      try {
        const entries = await readdir(config.cwd, { withFileTypes: true })
        for (const entry of entries) {
          if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
            watch(join(config.cwd, entry.name), { recursive: false }, () => {
              recordEvent()
            })
          }
        }
      } catch {
        // Non-fatal: top-level watch still works
      }
    } catch {
      // Non-fatal: fs.watch may fail in some environments (CI, containers)
      fsWatcher = undefined
    }
  }

  function stop(): void {
    fsWatcher?.close()
    fsWatcher = undefined
    events = []
  }

  return { start, stop, getState }
}
