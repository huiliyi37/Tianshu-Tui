/**
 * NDJSON sink for the agent event tap.
 *
 * Events go to a file rather than stdout because in TUI mode stdout IS the
 * render surface — interleaving JSON there would corrupt the screen. One JSON
 * object per line keeps the stream `jq`-able and tail-able while a run is live.
 */

import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs'
import { dirname } from 'node:path'
import type { SessionEvent } from '../server/protocol.js'
import type { EventSink } from './event-tap.js'

export interface EventStreamFile {
  sink: EventSink
  /**
   * Flush and close. Awaitable because `end()` is asynchronous — a fire-and-forget
   * close races process exit and drops the tail of the run, which is exactly the
   * part a consumer watching a crash cares about.
   */
  close: () => Promise<void>
}

export function createNdjsonEventSink(path: string): EventStreamFile {
  let stream: WriteStream | null = null
  let broken = false
  let brokenLogged = false

  const open = (): WriteStream | null => {
    if (stream || broken) return stream
    try {
      mkdirSync(dirname(path), { recursive: true })
      stream = createWriteStream(path, { flags: 'a' })
      stream.on('error', (err) => {
        if (!brokenLogged) {
          brokenLogged = true
          console.error(`[event-sink] stream error for ${path}:`, (err as Error).message)
        }
        broken = true
      })
    } catch {
      broken = true
    }
    return stream
  }

  return {
    sink: (event: SessionEvent) => {
      const out = open()
      if (!out) return
      try {
        out.write(JSON.stringify(event) + '\n')
      } catch {
        broken = true
      }
    },
    close: () => {
      const out = stream
      stream = null
      if (!out) return Promise.resolve()
      return new Promise<void>((resolve) => {
        try {
          out.end(() => resolve())
        } catch {
          resolve()
        }
      })
    },
  }
}
