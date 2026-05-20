import type { StreamClient } from '../api/stream-client.js'
import type { Message } from '../api/types.js'
import {
  CACHE_ANCHOR_MESSAGES,
  MIN_SUMMARIZE_MESSAGES,
  SUMMARY_INPUT_MAX_CHARS,
  SUMMARY_INPUT_HEAD_CHARS,
  SUMMARY_INPUT_TAIL_CHARS,
  LARGE_CONTEXT_WINDOW_TOKENS,
  KEEP_RECENT_MESSAGES,
  COMPACTION_SUMMARY_MAX_TOKENS,
  LARGE_CONTEXT_SUMMARY_INPUT_MAX_CHARS,
  LARGE_CONTEXT_SUMMARY_INPUT_HEAD_CHARS,
  LARGE_CONTEXT_SUMMARY_INPUT_TAIL_CHARS,
  LARGE_CONTEXT_SUMMARY_MAX_TOKENS,
} from './constants.js'
import { microCompact, estimateTokens } from './micro.js'
import type { CompactionConfig } from './constants.js'
import { createCompactBoundaryMessage, selectReactiveCompactRounds } from '../context/reactive-compact.js'

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
  estimatedTokenCount?: number,
): CompactionDecision {
  if (!config.enabled) {
    return { shouldCompact: false, reason: 'disabled', tokenCount: 0 }
  }

  const tokenCount = estimatedTokenCount ?? estimateTokens(messages)

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
  contextWindow = LARGE_CONTEXT_WINDOW_TOKENS,
): string {
  const isLargeContext = tokenCount >= LARGE_CONTEXT_WINDOW_TOKENS
  const scale = isLargeContext ? Math.min(2.5, Math.max(1, contextWindow / LARGE_CONTEXT_WINDOW_TOKENS)) : 1
  const maxChars = isLargeContext ? Math.floor(LARGE_CONTEXT_SUMMARY_INPUT_MAX_CHARS * scale) : SUMMARY_INPUT_MAX_CHARS
  const headChars = isLargeContext ? Math.floor(LARGE_CONTEXT_SUMMARY_INPUT_HEAD_CHARS * scale) : SUMMARY_INPUT_HEAD_CHARS
  const tailChars = isLargeContext ? Math.floor(LARGE_CONTEXT_SUMMARY_INPUT_TAIL_CHARS * scale) : SUMMARY_INPUT_TAIL_CHARS

  const serialized = oldMessages.map(m => {
    const content = typeof m.content === 'string'
      ? m.content
      : JSON.stringify(m.content)
    return `[${m.role}]: ${content}`
  }).join('\n')

  if (serialized.length <= maxChars) {
    return buildSummaryInstruction(serialized, isLargeContext, contextWindow)
  }

  const head = serialized.slice(0, headChars)
  const tail = serialized.slice(-tailChars)
  return buildSummaryInstruction(`${head}\n\n... (${oldMessages.length} messages omitted) ...\n\n${tail}`, isLargeContext, contextWindow)
}

function summaryWordLimit(isLargeContext: boolean, contextWindow: number): number {
  if (!isLargeContext) return 500
  return Math.min(1_800, Math.max(900, Math.floor(900 * (contextWindow / LARGE_CONTEXT_WINDOW_TOKENS))))
}

export function compactionSummaryMaxTokens(tokenCount: number, contextWindow: number): number {
  if (tokenCount < LARGE_CONTEXT_WINDOW_TOKENS) return COMPACTION_SUMMARY_MAX_TOKENS
  const scaled = Math.floor(LARGE_CONTEXT_SUMMARY_MAX_TOKENS * Math.min(2, Math.max(1, contextWindow / LARGE_CONTEXT_WINDOW_TOKENS)))
  return Math.min(4_096, Math.max(COMPACTION_SUMMARY_MAX_TOKENS, scaled))
}

function buildSummaryInstruction(history: string, isLargeContext: boolean, contextWindow: number): string {
  const wordLimit = summaryWordLimit(isLargeContext, contextWindow)
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

function isUnsafeSummary(summary: string): boolean {
  return /<\/?(?:context|system|tool_use|tool_result|assistant|user)\b/i.test(summary)
}

function shouldFallbackSummary(summary: string, tokenCount: number): boolean {
  const trimmed = summary.trim()
  if (!trimmed) return true
  if (isUnsafeSummary(trimmed)) return true
  const summaryTokens = Math.ceil(trimmed.length / 4)
  return summaryTokens >= Math.floor(tokenCount * 0.8)
}

export interface CompactResult {
  summary: string
  messages: Message[]
  truncatedCount: number
}

/**
 * Smart compact: send old messages to an LLM for summarization,
 * then replace them with a compact boundary containing the summary.
 *
 * Falls back to microCompact (truncation) on any LLM failure.
 */
export async function smartCompact(
  client: StreamClient,
  messages: Message[],
  tokenCount: number,
  contextWindow: number,
  compactModel: string,
): Promise<CompactResult> {
  if (messages.length <= KEEP_RECENT_MESSAGES + CACHE_ANCHOR_MESSAGES) {
    return { summary: '', messages, truncatedCount: 0 }
  }

  const anchorMessages = messages.slice(0, CACHE_ANCHOR_MESSAGES)
  const keepMessages = messages.slice(-KEEP_RECENT_MESSAGES)
  const oldMessages = messages.slice(CACHE_ANCHOR_MESSAGES, -KEEP_RECENT_MESSAGES)

  // Build summary prompt from old messages
  const summaryPrompt = buildSummaryPrompt(oldMessages, tokenCount, contextWindow)

  // Call LLM for summary
  let summary = ''
  try {
    await client.stream(
      {
        model: compactModel,
        messages: [{ role: 'user', content: summaryPrompt }],
        max_tokens: compactionSummaryMaxTokens(tokenCount, contextWindow),
        stream: true,
      },
      {
        onTextDelta: (t) => { summary += t },
        onThinkingDelta: () => {},
        onContentBlock: () => {},
        onStopReason: () => {},
        onError: () => {},
      },
    )
  } catch {
    // Fall back to microCompact on LLM failure
    const { messages: truncated, truncated: removedCount } = microCompact(messages, contextWindow, tokenCount)
    return { summary: '', messages: truncated, truncatedCount: removedCount }
  }

  if (shouldFallbackSummary(summary, tokenCount)) {
    const { messages: truncated, truncated: removedCount } = microCompact(messages, contextWindow, tokenCount)
    return { summary: '', messages: truncated, truncatedCount: removedCount }
  }

  summary = summary.trim()

  const selectedRounds = selectReactiveCompactRounds(messages, {
    anchorMessages: CACHE_ANCHOR_MESSAGES,
    recentMessages: KEEP_RECENT_MESSAGES,
  })
  // selectedRounds may be empty (nothing to compact); ?. handles the undefined case
  const firstRound = selectedRounds[0]
  const lastRound = selectedRounds[selectedRounds.length - 1]
  const safeStart = firstRound?.startMessageIndex ?? CACHE_ANCHOR_MESSAGES
  const safeEnd = lastRound?.endMessageIndex ?? Math.max(CACHE_ANCHOR_MESSAGES + 1, messages.length - KEEP_RECENT_MESSAGES - 1)
  const compactMessage = createCompactBoundaryMessage({
    startIndex: safeStart,
    endIndex: Math.max(safeStart + 1, safeEnd),
    summary,
    tokenBefore: tokenCount,
    tokenAfter: Math.ceil(summary.length / 4),
  })

  return {
    summary,
    messages: [...anchorMessages, compactMessage, ...keepMessages],
    truncatedCount: oldMessages.length,
  }
}
