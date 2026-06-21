import { join } from 'node:path'
import { getSessionDir } from './session-persist.js'
import type { PerceptionTelemetrySnapshot } from './perception.js'

export interface TelemetryWriter {
  write(snapshot: PerceptionTelemetrySnapshot): void
  flush(): Promise<void>
}

// The top-level (session-less) sensorium.jsonl accumulates across every session
// and was never bounded — it had grown to ~6MB / 10k+ lines over weeks. Keep a
// rolling tail instead. Checked on a throttled cadence so the trim cost (read +
// rewrite) is amortised, not paid per append.
const MAX_SENSORIUM_LINES = 2_000
const TRIM_CHECK_EVERY = 200

const NOOP_WRITER: TelemetryWriter = {
  write() {},
  async flush() {},
}

export function createTelemetryWriter(cwd: string, sessionId?: string): TelemetryWriter {
  if (!process.env['RIVET_DEBUG_TELEMETRY']) return NOOP_WRITER

  const dir = sessionId ? join(getSessionDir(cwd), sessionId) : join(cwd, '.rivet')
  const path = join(dir, 'sensorium.jsonl')
  const pendingWrites: Promise<void>[] = []
  let writesSinceTrim = 0
  return {
    write(snapshot) {
      const line = JSON.stringify(snapshot)
      const shouldTrim = ++writesSinceTrim >= TRIM_CHECK_EVERY
      if (shouldTrim) writesSinceTrim = 0
      const writePromise = import('node:fs/promises').then(async fs => {
        await fs.mkdir(dir, { recursive: true })
        await fs.appendFile(path, line + '\n', 'utf-8')
        if (shouldTrim) {
          // Best-effort rolling trim: keep only the most recent lines.
          try {
            const raw = await fs.readFile(path, 'utf-8')
            const lines = raw.split('\n').filter(l => l.length > 0)
            if (lines.length > MAX_SENSORIUM_LINES) {
              const tail = lines.slice(lines.length - MAX_SENSORIUM_LINES)
              await fs.writeFile(path, tail.join('\n') + '\n', 'utf-8')
            }
          } catch { /* trim is best-effort — never break telemetry */ }
        }
      }).catch(() => {})
      pendingWrites.push(writePromise)
      writePromise.finally(() => {
        const index = pendingWrites.indexOf(writePromise)
        if (index >= 0) pendingWrites.splice(index, 1)
      }).catch(() => {})
    },
    async flush() {
      await Promise.allSettled([...pendingWrites])
    },
  }
}
