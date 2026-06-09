import { watch, type FSWatcher } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { classifyPath } from './attention-filter.js'

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

export function shouldRecordFsEvent(relPath?: string): boolean {
  if (!relPath) return true
  return !classifyPath(relPath).silent
}

export interface FsEventRecorderOptions {
  windowMs?: number
  debounceMs?: number
  now?: () => number
}

export function createFsEventRecorder(options: FsEventRecorderOptions = {}) {
  const windowMs = options.windowMs ?? 60_000
  const debounceMs = options.debounceMs ?? 2_000
  const now = options.now ?? (() => Date.now())

  let events: number[] = []
  let lastEventTime = 0

  function recordEvent(relPath?: string): void {
    if (!shouldRecordFsEvent(relPath)) return

    const timestamp = now()
    if (timestamp - lastEventTime < debounceMs) return
    lastEventTime = timestamp
    events.push(timestamp)
  }

  function pruneOld(timestamp: number): void {
    events = events.filter(t => timestamp - t <= windowMs)
  }

  function getEventCount(): number {
    pruneOld(now())
    return events.length
  }

  function getEventRate(): number {
    return Math.min(1, getEventCount() / 30)
  }

  function reset(): void {
    events = []
    lastEventTime = 0
  }

  return { recordEvent, getEventCount, getEventRate, reset }
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
  const recorder = createFsEventRecorder({
    windowMs: config.windowMs,
    debounceMs: config.debounceMs,
  })

  let fsWatcher: FSWatcher | undefined
  let subWatchers: FSWatcher[] = []

  function getState(): FsWatcherState {
    const eventCount = recorder.getEventCount()
    return {
      eventRate: Math.min(1, eventCount / 30),
      eventCount,
      active: fsWatcher !== undefined,
    }
  }

  async function start(): Promise<void> {
    if (fsWatcher) return
    try {
      // Only watch top-level entries — recursive: false
      fsWatcher = watch(config.cwd, { recursive: false }, (_eventType, filename) => {
        recorder.recordEvent(typeof filename === 'string' ? filename : undefined)
      })
      // Also watch immediate subdirectories (src/, docs/, etc.) for deeper coverage
      try {
        const entries = await readdir(config.cwd, { withFileTypes: true })
        for (const entry of entries) {
          if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
            const sub = watch(join(config.cwd, entry.name), { recursive: false }, (_eventType, filename) => {
              recorder.recordEvent(typeof filename === 'string' ? join(entry.name, filename) : undefined)
            })
            subWatchers.push(sub)
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
    for (const sub of subWatchers) sub.close()
    subWatchers = []
    recorder.reset()
  }

  return { start, stop, getState }
}
