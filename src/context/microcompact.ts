import type { Message } from '../api/types.js'
import type { OaiMessage } from '../api/oai-types.js'
import { groupIntoRounds, computeInvariantStatus, groupIntoRoundsOai, computeOaiInvariantStatus } from './rounds.js'
import type { CompactedSpan, ContextLedger, MicrocompactOptions, MicrocompactResult } from './types.js'

export function microcompactToolResults(
  messages: Message[],
  options: MicrocompactOptions = {},
): MicrocompactResult {
  const keepRecent = options.keepRecentRounds ?? 4
  const minLength = options.minContentLength ?? 500
  const rounds = groupIntoRounds(messages)
  if (rounds.length <= keepRecent) {
    return { messages, compactedCount: 0, tokensSaved: 0, compactedRoundIds: [] }
  }

  const compactableRounds = rounds.slice(0, -keepRecent)
  let compactedCount = 0
  let tokensSaved = 0
  const compactedRoundIds: string[] = []

  const newMessages = messages.map((msg, msgIdx) => {
    if (msg.role !== 'user' || typeof msg.content === 'string') return msg
    const round = rounds.find(r => r.startMessageIndex <= msgIdx && msgIdx < r.endMessageIndex)
    if (!round || !compactableRounds.includes(round)) return msg
    if (!round.hasToolResult) return msg

    let modified = false
    const newBlocks = msg.content.map(block => {
      if (block.type !== 'tool_result') return block
      if (block.is_error) return block
      if (block.content.length < minLength) return block

      const lines = block.content.split('\n')
      const headLine = lines[0] ?? ''
      const tailLine = lines[lines.length - 1] ?? ''
      const stub = [headLine, `[compacted: ${lines.length} lines of tool output]`,
        tailLine !== headLine ? tailLine : ''].filter(Boolean).join('\n')

      tokensSaved += Math.ceil((block.content.length - stub.length) / 4)
      compactedCount++
      modified = true
      return { ...block, content: stub }
    })

    if (modified && !compactedRoundIds.includes(round.id)) {
      compactedRoundIds.push(round.id)
    }
    return modified ? { ...msg, content: newBlocks } : msg
  })

  return { messages: newMessages, compactedCount, tokensSaved, compactedRoundIds }
}

export function applyMicrocompact(
  ledger: ContextLedger,
  messages: OaiMessage[],
  options?: MicrocompactOptions,
): { ledger: ContextLedger; messages: OaiMessage[] } {
  const keepRecent = options?.keepRecentRounds ?? 4
  const rounds = groupIntoRoundsOai(messages)
  if (rounds.length <= keepRecent) return { ledger, messages }

  const compactableRounds = rounds.slice(0, -keepRecent)
  let compactedCount = 0
  let tokensSaved = 0

  const newMessages = messages.map((msg, msgIdx) => {
    if (msg.role !== 'tool') return msg
    const round = rounds.find(r => r.startMessageIndex <= msgIdx && msgIdx < r.endMessageIndex)
    if (!round || !compactableRounds.includes(round)) return msg
    if (!round.hasToolResults) return msg

    const content = typeof msg.content === 'string' ? msg.content : ''
    if (content.length < (options?.minContentLength ?? 500)) return msg

    const lines = content.split('\n')
    const headLine = lines[0] ?? ''
    const tailLine = lines[lines.length - 1] ?? ''
    const stub = [headLine, `[compacted: ${lines.length} lines of tool output]`,
      tailLine !== headLine ? tailLine : ''].filter(Boolean).join('\n')

    tokensSaved += Math.ceil((content.length - stub.length) / 4)
    compactedCount++

    return { ...msg, content: stub }
  })

  if (compactedCount === 0) return { ledger, messages }

  const span: CompactedSpan = {
    id: `micro_${Date.now()}`, strategy: 'micro', startRoundIndex: 0,
    endRoundIndex: ledger.rounds.length - keepRecent,
    tokenBefore: ledger.tokenBudget.estimatedTokens,
    tokenAfter: ledger.tokenBudget.estimatedTokens - tokensSaved,
    rawTranscriptPath: ledger.transcriptPath, createdAt: Date.now(),
  }

  const newRounds = groupIntoRoundsOai(newMessages)
  const estimatedTokens = newRounds.reduce((sum, r) => sum + r.tokenEstimate, 0)

  return {
    ledger: {
      ...ledger,
      rounds: newRounds,
      compactedSpans: [...ledger.compactedSpans, span],
      tokenBudget: { ...ledger.tokenBudget, estimatedTokens,
        compactionState: estimatedTokens > ledger.tokenBudget.maxTokens * 0.8 ? 'compacting' : 'warning' },
      apiInvariantStatus: computeOaiInvariantStatus(newRounds),
    },
    messages: newMessages,
  }
}
