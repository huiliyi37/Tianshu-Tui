import type { OaiChatRequest } from './oai-types.js'
import type { ContentBlock, Usage } from './types.js'

/** Diagnostic payload emitted when a stream attempt dies after partial output.
 *  4e1aaa21 post-mortem: aborted attempts silently discarded minutes of
 *  streamed reasoning; forensics had to reverse-engineer the loss from
 *  cache-log timestamp gaps. This event makes the discard observable. */
export interface StreamAttemptAbortedInfo {
  provider: string
  /** Characters received before the abort (reasoning + text deltas). */
  receivedChars: number
  /** Milliseconds from stream start to the abort. */
  elapsedMs: number
  errorName: string
  errorMessage: string
}

export interface StreamCallbacks {
  /** Streaming text delta for live display */
  onTextDelta: (text: string) => void
  /** Streaming thinking delta for live display */
  onThinkingDelta: (thinking: string) => void
  /** Complete content block (text, thinking, or tool_use with full input) */
  onContentBlock: (block: ContentBlock) => void
  /** Called when message_delta arrives with stop_reason + usage */
  onStopReason: (stopReason: string, usage: Partial<Usage>) => void
  onError: (error: Error) => void
  /** Hint: a tool call's name and partial args are parseable (for speculative prewarm). Optional. */
  onToolCallHint?: (toolName: string, partialArgs: Record<string, unknown>) => void
  /** Called when a rate limit (429) is encountered and being retried. Optional. */
  onRateLimit?: (retryDelayMs?: number) => void
  /** Called when a stream attempt aborts after receiving partial output (each failed attempt, before any retry). Optional. */
  onStreamAttemptAborted?: (info: StreamAttemptAbortedInfo) => void
}

/** Canonical streaming interface shared by all provider clients */
export interface StreamClient {
  stream(request: OaiChatRequest, callbacks: StreamCallbacks, signal?: AbortSignal): Promise<void>
  /** Update reasoning effort at runtime (optional — not all providers support this) */
  setReasoningEffort?(effort: string): void
  /** Toggle thinking/reasoning mode at runtime (GLM turn-level thinking). Optional — not all providers support this. */
  setThinking?(mode: 'enabled' | 'disabled'): void
}
