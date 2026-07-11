import { join } from 'node:path'
import { getSessionDir } from './session-persist.js'
import type { PerceptionTelemetrySnapshot } from './perception.js'

/**
 * A telemetry line is either the per-turn perception snapshot or a lightweight
 * tagged event (e.g. `{ kind: 'recall-summary', ... }`) sharing the same
 * sensorium.jsonl channel. Both are just JSON-stringified on write.
 */
export type TelemetryRecord = PerceptionTelemetrySnapshot | ({ kind: string } & Record<string, unknown>)

export interface TelemetryWriter {
  write(snapshot: TelemetryRecord): void
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

/** W5：轻量生命体征行的 kind 标记 — lite 模式下唯一放行的记录类型 */
export const VITALS_LITE_KIND = 'vitals-lite'

export function createTelemetryWriter(cwd: string, sessionId?: string): TelemetryWriter {
  // W5（incident 20b9714e）：完整遥测仍由 RIVET_DEBUG_TELEMETRY opt-in，但
  // 轻量生命体征行（vitals-lite，单行 <200B）默认落盘——没有它，事后复盘
  // "节流何时触发/镜面是否存活/advisory 台账"全都无数据。RIVET_TELEMETRY_LITE=0 可关。
  const full = !!process.env['RIVET_DEBUG_TELEMETRY']
  const lite = process.env['RIVET_TELEMETRY_LITE'] !== '0'
  if (!full && !lite) return NOOP_WRITER

  const dir = sessionId ? join(getSessionDir(cwd), sessionId) : join(cwd, '.rivet')
  const path = join(dir, 'sensorium.jsonl')
  const pendingWrites: Promise<void>[] = []
  let writesSinceTrim = 0
  return {
    write(snapshot: TelemetryRecord) {
      if (!full && (snapshot as { kind?: string }).kind !== VITALS_LITE_KIND) return
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
