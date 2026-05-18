import { join } from 'node:path'
import type { PerceptionTelemetrySnapshot } from './perception.js'

export interface TelemetryWriter {
  write(snapshot: PerceptionTelemetrySnapshot): void
  flush(): Promise<void>
}

export function createTelemetryWriter(cwd: string): TelemetryWriter {
  const path = join(cwd, '.rivet', 'sensorium.jsonl')
  const pendingWrites: Promise<void>[] = []
  return {
    write(snapshot) {
      const line = JSON.stringify(snapshot)
      const writePromise = import('node:fs/promises').then(async fs => {
        await fs.mkdir(join(cwd, '.rivet'), { recursive: true })
        await fs.appendFile(path, line + '\n', 'utf-8')
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
