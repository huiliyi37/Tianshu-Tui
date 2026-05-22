import type { StreamCallbacks } from '../api/stream-client.js'
import type { StreamClient } from '../api/stream-client.js'
import type { OaiChatRequest } from '../api/oai-types.js'
import type { ContentBlock, Usage } from '../api/types.js'
import { stripIntraTurnRepetition } from './dedup.js'

export interface TurnStreamCallbacks {
  onTextDelta: (text: string) => void
  onThinkingDelta: (thinking: string) => void
  onToolUse: (id: string, name: string, input: Record<string, unknown>) => void
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
  addUsage: (usage: Partial<Usage>) => void
  recordTurnCache: (turn: number, usage: Usage) => void
}

export interface TurnStreamInput {
  request: OaiChatRequest
  turn: number
  lastTurnTextFingerprint: string
  callbacks: TurnStreamCallbacks
}

export interface TurnStreamResult {
  collectedBlocks: ContentBlock[]
  thinkingAccum: string
  toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>
  stopReason: string
  streamError: Error | null
  lastTurnTextFingerprint: string
}

function isToolUse(b: ContentBlock): b is ContentBlock & { type: 'tool_use'; id: string; name: string } {
  return b.type === 'tool_use'
}

function displayTextFingerprint(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export class TurnStreamController {
  constructor(private deps: TurnStreamDeps) {}

  async streamTurn(input: TurnStreamInput): Promise<TurnStreamResult> {
    const collectedBlocks: ContentBlock[] = []
    let thinkingAccum = ''
    const toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> = []
    let stopReason = ''
    let turnDisplayBuffer = ''

    const streamCallbacks: StreamCallbacks = {
      onTextDelta: (text) => {
        this.deps.appendStreamedText(text)
        if (this.deps.getStreamedTextLength() - this.deps.getLastPrewarmAt() >= 500) {
          this.deps.setLastPrewarmAt(this.deps.getStreamedTextLength())
          this.deps.maybePrewarm(text)
        }
        turnDisplayBuffer += text
      },
      onThinkingDelta: (thinking) => {
        thinkingAccum += thinking
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
    }

    let streamError: Error | null = null
    try {
      await this.deps.client.stream(input.request, streamCallbacks, this.deps.abortSignal)
    } catch (err) {
      const estimatedOut = this.deps.getStreamedTextLength() + collectedBlocks.reduce((sum, block) => (
        sum + (block.type === 'text' ? block.text.length : 0)
      ), 0)
      if (estimatedOut > 0) {
        this.deps.addUsage({ output_tokens: Math.ceil(estimatedOut / 4) })
      }
      streamError = err as Error
    }

    const dedupedBuffer = stripIntraTurnRepetition(turnDisplayBuffer)
    const nextFingerprint = displayTextFingerprint(dedupedBuffer)
    if (dedupedBuffer && nextFingerprint !== input.lastTurnTextFingerprint) {
      input.callbacks.onTextDelta(dedupedBuffer)
    }

    return {
      collectedBlocks,
      thinkingAccum,
      toolUses,
      stopReason,
      streamError,
      lastTurnTextFingerprint: nextFingerprint,
    }
  }
}
