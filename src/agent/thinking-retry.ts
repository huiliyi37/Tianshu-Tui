export interface ThinkingRetryState {
  lastThinkingContent: string
  thinkingOnlyRetries: number
}

export interface ThinkingRetryInput {
  streamedText: string
  collectedBlockCount: number
  thinkingAccum: string
  thinkingOnlyRetries: number
  lastThinkingContent: string
}

export interface ThinkingRetryResult {
  shouldRetry: boolean
  isLooping: boolean
  nextState: ThinkingRetryState
  retryMessage: string
}

export function evaluateThinkingRetry(input: ThinkingRetryInput): ThinkingRetryResult {
  const { streamedText, collectedBlockCount, thinkingAccum, thinkingOnlyRetries, lastThinkingContent } = input

  if (streamedText.length > 0 || collectedBlockCount > 0 || thinkingOnlyRetries >= 1) {
    return {
      shouldRetry: false, isLooping: false,
      nextState: { lastThinkingContent: '', thinkingOnlyRetries: 0 },
      retryMessage: '',
    }
  }

  // Completely empty response (no text, no blocks, no thinking).
  // Retrying is pointless — the model produced nothing to recover from.
  // End the turn and let the user decide what to do.
  if (thinkingAccum.length === 0) {
    return {
      shouldRetry: false, isLooping: false,
      nextState: { lastThinkingContent: '', thinkingOnlyRetries: 0 },
      retryMessage: '',
    }
  }

  const midChunk = thinkingAccum.length > 400 ? thinkingAccum.slice(150, 250) : ''
  const repeatsInBlock = midChunk.length > 0 && (thinkingAccum.split(midChunk).length - 1) >= 3

  const isLooping = (lastThinkingContent.length > 0 &&
    thinkingAccum.slice(0, 600) === lastThinkingContent.slice(0, 600)) ||
    repeatsInBlock

  if (isLooping) {
    return { shouldRetry: false, isLooping: true, nextState: { lastThinkingContent: '', thinkingOnlyRetries: 0 }, retryMessage: '' }
  }

  return {
    shouldRetry: true,
    isLooping: false,
    nextState: { lastThinkingContent: thinkingAccum, thinkingOnlyRetries: thinkingOnlyRetries + 1 },
    retryMessage: 'Please respond directly without additional thinking. Just output your answer.',
  }
}
