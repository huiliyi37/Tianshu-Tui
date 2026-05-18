import { join } from 'node:path'
import type { PerceptionTelemetrySnapshot } from './perception.js'

export interface TelemetryWriter {
  write(snapshot: PerceptionTelemetrySnapshot): void
}

export function createTelemetryWriter(cwd: string): TelemetryWriter {
  const path = join(cwd, '.rivet', 'sensorium.jsonl')
  return {
    write(snapshot) {
      const line = JSON.stringify(snapshot)
      import('node:fs/promises').then(async fs => {
        await fs.mkdir(join(cwd, '.rivet'), { recursive: true })
        await fs.appendFile(path, line + '\n', 'utf-8')
      }).catch(() => {})
    },
  }
}
