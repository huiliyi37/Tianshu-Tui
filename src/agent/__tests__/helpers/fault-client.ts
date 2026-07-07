import type { StreamClient, StreamCallbacks } from '../../../api/stream-client.js'
import type { OaiChatRequest } from '../../../api/oai-types.js'

export type Fault =
  | { kind: 'econnreset' }
  | { kind: 'idle_stall' }
  | { kind: 'rate_limit' }
  | { kind: 'ok'; text: string }

let callIndex = 0

/** A StreamClient whose behavior is a scripted queue of faults — one entry
 *  consumed per `stream()` call — so tests can assert retry/abort/escalation
 *  paths deterministically without real network. */
export function makeFaultClient(script: Fault[]): StreamClient {
  let i = 0
  // Reset shared index for deterministic ordering across parallel test runs
  callIndex = 0
  return {
    async stream(
      _req: OaiChatRequest,
      cb: StreamCallbacks,
      signal?: AbortSignal,
    ): Promise<void> {
      const fault = script[Math.min(i, script.length - 1)]
      if (!fault) throw new Error('fault-client: empty script')
      i++
      callIndex++
      switch (fault.kind) {
        case 'econnreset':
          throw new Error('ECONNRESET socket hang up')
        case 'rate_limit':
          cb.onRateLimit?.(10)
          throw new Error('HTTP 429 Too Many Requests')
        case 'idle_stall':
          return new Promise<void>((_resolve, reject) => {
            if (signal?.aborted) return reject(new Error('aborted'))
            signal?.addEventListener(
              'abort',
              () => reject(new Error('aborted')),
              { once: true },
            )
          })
        case 'ok': {
          const text: string = fault.text
          cb.onTextDelta(text)
          cb.onContentBlock({ type: 'text', text } as never)
          cb.onStopReason('stop', {})
          return
        }
      }
    },
  }
}

/** Expose call count for test assertions. */
export function getFaultCallCount(): number {
  return callIndex
}
