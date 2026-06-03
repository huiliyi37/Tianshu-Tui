import type { StreamCallbacks } from '../api/stream-client.js'
import type { StreamClient } from '../api/stream-client.js'
import type { OaiChatRequest } from '../api/oai-types.js'
import type { ContentBlock, Usage } from '../api/types.js'
import { stripIntraTurnRepetition } from './dedup.js'

export interface StreamRule {
  /** Regex pattern to match against the accumulated text stream.
   *  When matched, the stream is aborted and the rule's inject message
   *  is appended as a system reminder before retrying. */
  pattern: string
  /** System reminder injected into the conversation when the rule triggers. */
  inject: string
}

/** Built-in safety-net rules — always active, even without user config.
 *  These catch the most dangerous patterns that no model should ever generate. */
export const DEFAULT_STREAM_RULES: readonly StreamRule[] = [
  { pattern: 'rm\\s+-rf\\s+/(?![a-zA-Z])', inject: 'STOP: Never execute rm -rf / without a specific path. This will destroy the system.' },
  { pattern: 'curl[^\\n]*\\|\\s*(?:sh|bash)', inject: 'STOP: Never pipe curl output directly to a shell. Download first, inspect, then run.' },
  { pattern: 'DROP\\s+TABLE', inject: 'STOP: Do not execute DROP TABLE without explicit user confirmation. This is irreversible.' },
]

export interface TurnStreamCallbacks {
  onTextDelta: (text: string) => void
  onThinkingDelta: (thinking: string) => void
  onToolUse: (id: string, name: string, input: Record<string, unknown>) => void
  onToolHint?: (name: string) => void
  onStreamStart?: () => void
  onError: (error: Error) => void
}

export interface TurnStreamDeps {
  client: StreamClient
  abortSignal: AbortSignal
  getStreamedTextLength: () => number
  appendStreamedText: (text: string) => void
  getLastPrewarmAt: () => number
  setLastPrewarmAt: (position: number) => void
  maybePrewarm: (text: string) => void
  /** Direct file prewarm for speculative tool call hints */
  prewarmFile?: (filePath: string) => void
  addUsage: (usage: Partial<Usage>) => void
  recordTurnCache: (turn: number, usage: Usage) => void
}

export interface TurnStreamInput {
  request: OaiChatRequest
  turn: number
  lastTurnTextFingerprint: string
  callbacks: TurnStreamCallbacks
  /** Optional stream rules — abort and inject when accumulated text matches a pattern. */
  streamRules?: StreamRule[]
}

export interface TurnStreamResult {
  collectedBlocks: ContentBlock[]
  thinkingAccum: string
  toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>
  stopReason: string
  streamError: Error | null
  lastTurnTextFingerprint: string
  lastTurnThinkingFingerprint: string
  /** Set when a stream rule triggered the abort — caller should inject the rule and retry. */
  triggeredRule?: StreamRule
}

function isToolUse(b: ContentBlock): b is ContentBlock & { type: 'tool_use'; id: string; name: string } {
  return b.type === 'tool_use'
}

function displayTextFingerprint(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Error thrown when a stream rule matches — caught and distinguished from real AbortErrors. */
class RuleTriggeredError extends Error {
  constructor(public readonly rule: StreamRule) {
    super('Stream rule triggered')
    this.name = 'RuleTriggeredError'
  }
}

export class TurnStreamController {
  constructor(private deps: TurnStreamDeps) {}

  async streamTurn(input: TurnStreamInput): Promise<TurnStreamResult> {
    const collectedBlocks: ContentBlock[] = []
    let thinkingAccum = ''
    const toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> = []
    let stopReason = ''
    let turnDisplayBuffer = ''
    const CHUNK_DEDUP_HISTORY = 5
    const chunkHistory: string[] = []
    const thinkingChunkHistory: string[] = []

    // TTSR: compile stream rule patterns once â default rules always active
    const rules = [...DEFAULT_STREAM_RULES, ...(input.streamRules ?? [])]
    const compiledRules = rules.map(r => ({ ...r, regex: new RegExp(r.pattern, 'si') }))
    let triggeredRule: StreamRule | undefined

    const streamCallbacks: StreamCallbacks = {
      onTextDelta: (text) => {
        this.deps.appendStreamedText(text)
        if (this.deps.getStreamedTextLength() - this.deps.getLastPrewarmAt() >= 500) {
          this.deps.setLastPrewarmAt(this.deps.getStreamedTextLength())
          const t = text
          setImmediate(() => this.deps.maybePrewarm(t))
        }
        turnDisplayBuffer += text
        // Real-time push with duplicate-chunk guard (DeepSeek repeats 50+ char chunks)
        // Check recent history for both consecutive and non-consecutive duplicates
        if (text.length >= 50 && chunkHistory.includes(text)) {
          return // skip duplicate — appendStreamedText/turnDisplayBuffer already updated above
        }
        if (text.length >= 50) {
          chunkHistory.push(text)
          if (chunkHistory.length > CHUNK_DEDUP_HISTORY) {
            chunkHistory.shift()
          }
        }
        input.callbacks.onTextDelta(text)

        // TTSR: check accumulated text against stream rules
        if (!triggeredRule && compiledRules.length > 0) {
          for (const rule of compiledRules) {
            if (rule.regex.test(turnDisplayBuffer)) {
              triggeredRule = { pattern: rule.pattern, inject: rule.inject }
              throw new RuleTriggeredError(triggeredRule)
            }
          }
        }
      },
      onThinkingDelta: (thinking) => {
        thinkingAccum += thinking
        // Duplicate-chunk guard for thinking content (mirrors text dedup above).
        // DeepSeek/MiMo can repeat 50+ char reasoning chunks verbatim.
        if (thinking.length >= 50 && thinkingChunkHistory.includes(thinking)) {
          return // skip duplicate — thinkingAccum already updated above
        }
        if (thinking.length >= 50) {
          thinkingChunkHistory.push(thinking)
          if (thinkingChunkHistory.length > CHUNK_DEDUP_HISTORY) {
            thinkingChunkHistory.shift()
          }
        }
        input.callbacks.onThinkingDelta(thinking)
      },
      onContentBlock: (block) => {
        collectedBlocks.push(block)
        if (isToolUse(block)) {
          toolUses.push({ id: block.id, name: block.name, input: block.input })
          input.callbacks.onToolUse(block.id, block.name, block.input)
        }
      },
      onStopReason: (reason, usage) => {
        stopReason = reason
        this.deps.addUsage(usage)
        if (usage.cache_read_input_tokens !== undefined || usage.cache_creation_input_tokens !== undefined) {
          this.deps.recordTurnCache(input.turn, {
            input_tokens: usage.input_tokens ?? 0,
            output_tokens: usage.output_tokens ?? 0,
            cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
            cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
          })
        }
      },
      onError: (error) => {
        input.callbacks.onError(error)
      },
      onToolCallHint: (toolName, partialArgs) => {
        input.callbacks.onToolHint?.(toolName)
        if (toolName === 'read_file' && typeof partialArgs.file_path === 'string') {
          const fp = partialArgs.file_path
          setImmediate(() => this.deps.prewarmFile?.(fp))
        }
      },
    }

    let streamError: Error | null = null
    try {
      input.callbacks.onStreamStart?.()
      await this.deps.client.stream(input.request, streamCallbacks, this.deps.abortSignal)
    } catch (err) {
      // TTSR: extract triggeredRule from RuleTriggeredError, suppress as error
      if (err instanceof RuleTriggeredError) {
        triggeredRule = err.rule
      } else {
        const estimatedOut = this.deps.getStreamedTextLength() + collectedBlocks.reduce((sum, block) => (
          sum + (block.type === 'text' ? block.text.length : 0)
        ), 0)
        if (estimatedOut > 0) {
          this.deps.addUsage({ output_tokens: Math.ceil(estimatedOut / 4) })
        }
        streamError = err as Error
      }
    }

    const dedupedBuffer = stripIntraTurnRepetition(turnDisplayBuffer)
    const nextFingerprint = displayTextFingerprint(dedupedBuffer)

    return {
      collectedBlocks,
      thinkingAccum,
      toolUses,
      stopReason,
      streamError,
      lastTurnTextFingerprint: nextFingerprint,
      lastTurnThinkingFingerprint: displayTextFingerprint(thinkingAccum),
      triggeredRule,
    }
  }
}
