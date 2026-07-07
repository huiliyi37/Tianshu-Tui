import { mock } from 'node:test'
import type { StreamClient } from '../../api/stream-client.js'
import type { StreamCallbacks } from '../../api/stream-client.js'
import type { OaiChatRequest } from '../../api/oai-types.js'
import { ContextClaimStore } from '../../context/claim-store.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

/** Record of a single stream() invocation for test assertions */
export interface StreamCallRecord {
  request: OaiChatRequest
  text: string
  stopped: boolean
}

/**
 * A StreamClient that replays pre-configured text sequences per call.
 * Useful for simulating LLM responses in subagent integration tests.
 *
 * Each entry in `responses` is a "call set" containing one or more sequential
 * rounds. Successive stream() calls within the same call set return successive
 * rounds. When all rounds are exhausted, the next stream() call moves to the
 * next call set.
 */
export class MockStreamClient implements StreamClient {
  /** All recorded stream() calls in order */
  readonly calls: StreamCallRecord[] = []
  private readonly responses: Array<Array<{ text: string; stopReason?: string }>>
  private callIndex = 0
  private roundIndex = 0

  /**
   * @param responses - Each entry is a "call set", containing an array of sequential
   *   rounds (text + stop reason). Successive stream() calls within a call set
   *   return successive rounds; when rounds are exhausted, advances to next set.
   */
  constructor(responses: Array<Array<{ text: string; stopReason?: string }>>) {
    this.responses = responses
  }

  stream = mock.fn(async (request: OaiChatRequest, cb: StreamCallbacks, _signal?: AbortSignal): Promise<void> => {
    const callSet = this.responses[Math.min(this.callIndex, this.responses.length - 1)] ?? []
    const round = callSet[Math.min(this.roundIndex, callSet.length - 1)] ?? { text: '' }

    this.calls.push({ request, text: round.text, stopped: false })

    // Emit text delta
    if (round.text) {
      cb.onTextDelta(round.text)
      cb.onContentBlock({ type: 'text', text: round.text })
    }

    cb.onStopReason(round.stopReason ?? 'end_turn', {
      input_tokens: 100,
      output_tokens: 50,
    })

    // Advance round; if exhausted, advance to next call set
    this.roundIndex++
    if (this.roundIndex >= callSet.length) {
      this.callIndex++
      this.roundIndex = 0
    }
  })

  setReasoningEffort?: (effort: string) => void
}

/**
 * Creates a MockStreamClient that returns the given text(s) for successive calls.
 * Each text is its own call set with a single round.
 */
export function mockClientFromTexts(texts: string[]): MockStreamClient {
  return new MockStreamClient(texts.map(text => [{ text }]))
}

/**
 * Creates a MockStreamClient where each call set has multiple rounds
 * (useful for simulating multiple stream() calls within a single worker session).
 */
export function mockClientFromMultiRoundTexts(rounds: string[][]): MockStreamClient {
  return new MockStreamClient(rounds.map(texts => texts.map(text => ({ text }))))
}

/**
 * A temporary-directory-backed ContextClaimStore that auto-cleans on dispose.
 * Uses a unique session ID to avoid collisions in parallel tests.
 */
export class MockClaimStore extends ContextClaimStore {
  readonly tempDir: string

  constructor(sessionId?: string) {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-claim-test-'))
    super(dir, sessionId ?? `mock-session-${randomUUID()}`)
    this.tempDir = dir
  }

  /** Remove temp directory and all contents */
  dispose(): void {
    try {
      rmSync(this.tempDir, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
  }
}
