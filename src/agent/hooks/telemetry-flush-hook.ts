import type { PostSessionRuntimeHook } from '../runtime-hooks.js'
import type { TelemetryWriter } from '../telemetry-writer.js'

export function createTelemetryFlushHook(writer: TelemetryWriter): PostSessionRuntimeHook {
  return {
    phase: 'postSession',
    name: 'telemetry-flush',
    async run() {
      await writer.flush()
    },
  }
}
