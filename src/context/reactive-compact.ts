import type { Message } from '../api/types.js'
import { groupIntoRounds } from './rounds.js'
import type { ApiRound } from './types.js'

export interface ReactiveRoundSelectionOptions {
  anchorMessages: number
  recentMessages: number
}

export interface CompactBoundaryInput {
  startIndex: number
  endIndex: number
  summary: string
  tokenBefore: number
  tokenAfter: number
}

export function selectReactiveCompactRounds(messages: Message[], options: ReactiveRoundSelectionOptions): ApiRound[] {
  const rounds = groupIntoRounds(messages)
  const anchorEnd = Math.min(options.anchorMessages - 1, messages.length - 1)
  const recentStart = Math.max(0, messages.length - options.recentMessages)
  return rounds.filter(round => round.startMessageIndex > anchorEnd && round.endMessageIndex <= recentStart && round.apiInvariant === 'ok')
}

function escapeAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

export function createCompactBoundaryMessage(input: CompactBoundaryInput): Message {
  return {
    role: 'user',
    content: `<compact-summary source_start="${input.startIndex}" source_end="${input.endIndex}" token_before="${input.tokenBefore}" token_after="${input.tokenAfter}">\n${escapeAttr(input.summary)}\n</compact-summary>`,
  }
}
