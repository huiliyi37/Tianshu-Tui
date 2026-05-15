import type { Message } from '../api/types.js'
import {
  MIN_SUMMARIZE_MESSAGES,
  SUMMARY_INPUT_MAX_CHARS,
  SUMMARY_INPUT_HEAD_CHARS,
  SUMMARY_INPUT_TAIL_CHARS,
  LARGE_CONTEXT_WINDOW_TOKENS,
} from './constants.js'
import { estimateTokens } from './micro.js'
import type { CompactionConfig } from './constants.js'

export interface CompactionDecision {
  shouldCompact: boolean
  reason: 'below_floor' | 'below_threshold' | 'not_enough_messages' | 'triggered' | 'disabled'
  tokenCount: number
}

/**
 * Decide whether automatic compaction should fire.
 *
 * Rules (from DeepSeek TUI compaction.rs v0.8.11):
 * 1. Compaction must be enabled
 * 2. Token count must exceed autoFloor (500K) — protects healthy cache
 * 3. Token count must exceed autoThreshold (800K for V4 1M)
 * 4. Must have at least MIN_SUMMARIZE_MESSAGES (6) to summarize
 */
export function shouldAutoCompact(
  messages: Message[],
  config: CompactionConfig,
): CompactionDecision {
  if (!config.enabled) {
    return { shouldCompact: false, reason: 'disabled', tokenCount: 0 }
  }

  const tokenCount = estimateTokens(messages)

  if (tokenCount < config.autoFloor) {
    return { shouldCompact: false, reason: 'below_floor', tokenCount }
  }

  if (tokenCount < config.autoThreshold) {
    return { shouldCompact: false, reason: 'below_threshold', tokenCount }
  }

  if (messages.length < MIN_SUMMARIZE_MESSAGES) {
    return { shouldCompact: false, reason: 'not_enough_messages', tokenCount }
  }

  return { shouldCompact: true, reason: 'triggered', tokenCount }
}

/**
 * Build the summary prompt from old messages that will be truncated.
 *
 * DeepSeek TUI's approach: extract head + tail of conversation history
 * and send to a small model for summarization. The summary replaces
 * old messages and is injected into the next user message <context>.
 */
export function buildSummaryPrompt(
  oldMessages: Message[],
  tokenCount: number,
): string {
  const isLargeContext = tokenCount >= LARGE_CONTEXT_WINDOW_TOKENS
  const maxChars = isLargeContext ? 120_000 : SUMMARY_INPUT_MAX_CHARS
  const headChars = isLargeContext ? 72_000 : SUMMARY_INPUT_HEAD_CHARS
  const tailChars = isLargeContext ? 36_000 : SUMMARY_INPUT_TAIL_CHARS

  const serialized = oldMessages.map(m => {
    const content = typeof m.content === 'string'
      ? m.content
      : JSON.stringify(m.content)
    return `[${m.role}]: ${content}`
  }).join('\n')

  if (serialized.length <= maxChars) {
    return buildSummaryInstruction(serialized, isLargeContext)
  }

  const head = serialized.slice(0, headChars)
  const tail = serialized.slice(-tailChars)
  return buildSummaryInstruction(`${head}\n\n... (${oldMessages.length} messages omitted) ...\n\n${tail}`, isLargeContext)
}

function buildSummaryInstruction(history: string, isLargeContext: boolean): string {
  const wordLimit = isLargeContext ? 900 : 500
  return `Summarize the following conversation history in ${wordLimit} words or fewer. Focus on:
1. Key decisions made
2. Files changed and why
3. Bugs discovered and their fixes
4. Current blockers or open questions

<conversation>
${history}
</conversation>

Provide a concise summary (${wordLimit} words max):`
}
