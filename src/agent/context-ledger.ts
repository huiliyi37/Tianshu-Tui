import type { Message, ContentBlock } from '../api/types.js'
import { estimateMessageTokens } from '../compact/micro.js'

// ─── Phase 1: Types ────────────────────────────────────────────

export interface ApiRound {
  id: string
  startMessageIndex: number
  endMessageIndex: number
  turnNumber: number
  hasToolUse: boolean
  hasToolResult: boolean
  tokenEstimate: number
  compactableTokenEstimate: number
  apiInvariant: 'ok' | 'repaired' | 'broken'
}

export interface CompactedSpan {
  id: string
  strategy: 'micro' | 'session_memory' | 'reactive' | 'emergency'
  startRoundIndex: number
  endRoundIndex: number
  tokenBefore: number
  tokenAfter: number
  summaryPath?: string
  rawTranscriptPath: string
  createdAt: number
}

export interface ContextAnchor {
  kind: 'decision' | 'error' | 'user_preference' | 'pending_task' | 'file' | 'verification'
  text: string
  sourceRoundIndex: number
  salience: number
}

export interface WorkingSetEntry {
  path: string
  status: 'read' | 'modified' | 'error' | 'pending'
  lastRoundIndex: number
}

export interface SessionMemoryState {
  path: string
  lastSummarizedRoundIndex: number
  lastUpdatedAt: number
  digest: string
  stale: boolean
  tokenEstimate: number
}

export interface ContextBudget {
  estimatedTokens: number
  maxTokens: number
  warningThreshold: number
  compactionState: 'healthy' | 'warning' | 'compacting' | 'critical'
}

export interface ApiInvariantStatus {
  totalRounds: number
  okRounds: number
  repairedRounds: number
  brokenRounds: number
  orphanToolUse: string[]
  orphanToolResult: string[]
}

export interface ContextLedger {
  sessionId: string
  transcriptPath: string
  rounds: ApiRound[]
  anchors: ContextAnchor[]
  workingSet: WorkingSetEntry[]
  compactedSpans: CompactedSpan[]
  sessionMemory: SessionMemoryState | null
  tokenBudget: ContextBudget
  apiInvariantStatus: ApiInvariantStatus
}

// ─── Phase 1: Round Grouping ───────────────────────────────────

function extractToolUseIds(blocks: ContentBlock[]): string[] {
  return blocks
    .filter((b): b is ContentBlock & { type: 'tool_use'; id: string } => b.type === 'tool_use')
    .map(b => b.id)
}

function extractToolResultIds(blocks: ContentBlock[]): string[] {
  return blocks
    .filter((b): b is ContentBlock & { type: 'tool_result'; tool_use_id: string } => b.type === 'tool_result')
    .map(b => b.tool_use_id)
}

function isUserTextMessage(msg: Message): boolean {
  return msg.role === 'user' && typeof msg.content === 'string'
}

function hasToolUseBlocks(msg: Message): boolean {
  if (msg.role !== 'assistant' || typeof msg.content === 'string') return false
  return msg.content.some(b => b.type === 'tool_use')
}

function hasToolResultBlocks(msg: Message): boolean {
  if (msg.role !== 'user' || typeof msg.content === 'string') return false
  return msg.content.some(b => b.type === 'tool_result')
}

function estimateCompactableTokens(round: { messages: Message[] }): number {
  let tokens = 0
  for (const msg of round.messages) {
    if (msg.role !== 'user' || typeof msg.content === 'string') continue
    for (const block of msg.content) {
      if (block.type === 'tool_result' && block.content.length > 200) {
        tokens += Math.ceil(block.content.length / 4)
      }
    }
  }
  return tokens
}

export function groupIntoRounds(messages: Message[]): ApiRound[] {
  const rounds: ApiRound[] = []
  let i = 0
  let roundId = 0
  let turnNumber = 0

  while (i < messages.length) {
    const msg = messages[i]!
    const startIndex = i

    if (isUserTextMessage(msg)) {
      turnNumber++
      rounds.push({
        id: `round_${roundId++}`,
        startMessageIndex: startIndex,
        endMessageIndex: i + 1,
        turnNumber,
        hasToolUse: false,
        hasToolResult: false,
        tokenEstimate: estimateMessageTokens(msg),
        compactableTokenEstimate: 0,
        apiInvariant: 'ok',
      })
      i++
      continue
    }

    if (msg.role === 'assistant' && !hasToolUseBlocks(msg)) {
      rounds.push({
        id: `round_${roundId++}`,
        startMessageIndex: startIndex,
        endMessageIndex: i + 1,
        turnNumber,
        hasToolUse: false,
        hasToolResult: false,
        tokenEstimate: estimateMessageTokens(msg),
        compactableTokenEstimate: 0,
        apiInvariant: 'ok',
      })
      i++
      continue
    }

    if (msg.role === 'assistant' && hasToolUseBlocks(msg)) {
      const toolUseIds = extractToolUseIds(msg.content as ContentBlock[])
      const nextMsg = messages[i + 1]

      if (nextMsg && nextMsg.role === 'user' && hasToolResultBlocks(nextMsg)) {
        const toolResultIds = extractToolResultIds(nextMsg.content as ContentBlock[])
        const missingResults = toolUseIds.filter(id => !toolResultIds.includes(id))
        const orphanResults = toolResultIds.filter(id => !toolUseIds.includes(id))

        let invariant: ApiRound['apiInvariant'] = 'ok'
        if (missingResults.length > 0) invariant = 'broken'
        else if (orphanResults.length > 0) invariant = 'repaired'

        const tokenEstimate = estimateMessageTokens(msg) + estimateMessageTokens(nextMsg)
        const compactable = estimateCompactableTokens({ messages: [msg, nextMsg] })

        rounds.push({
          id: `round_${roundId++}`,
          startMessageIndex: startIndex,
          endMessageIndex: i + 2,
          turnNumber,
          hasToolUse: true,
          hasToolResult: true,
          tokenEstimate,
          compactableTokenEstimate: compactable,
          apiInvariant: invariant,
        })
        i += 2
        continue
      }

      rounds.push({
        id: `round_${roundId++}`,
        startMessageIndex: startIndex,
        endMessageIndex: i + 1,
        turnNumber,
        hasToolUse: true,
        hasToolResult: false,
        tokenEstimate: estimateMessageTokens(msg),
        compactableTokenEstimate: 0,
        apiInvariant: 'broken',
      })
      i++
      continue
    }

    if (msg.role === 'user' && hasToolResultBlocks(msg)) {
      rounds.push({
        id: `round_${roundId++}`,
        startMessageIndex: startIndex,
        endMessageIndex: i + 1,
        turnNumber,
        hasToolUse: false,
        hasToolResult: true,
        tokenEstimate: estimateMessageTokens(msg),
        compactableTokenEstimate: estimateCompactableTokens({ messages: [msg] }),
        apiInvariant: 'repaired',
      })
      i++
      continue
    }

    rounds.push({
      id: `round_${roundId++}`,
      startMessageIndex: startIndex,
      endMessageIndex: i + 1,
      turnNumber,
      hasToolUse: false,
      hasToolResult: false,
      tokenEstimate: estimateMessageTokens(msg),
      compactableTokenEstimate: 0,
      apiInvariant: 'ok',
    })
    i++
  }

  return rounds
}

export function computeInvariantStatus(rounds: ApiRound[]): ApiInvariantStatus {
  const status: ApiInvariantStatus = {
    totalRounds: rounds.length,
    okRounds: 0,
    repairedRounds: 0,
    brokenRounds: 0,
    orphanToolUse: [],
    orphanToolResult: [],
  }

  for (const round of rounds) {
    switch (round.apiInvariant) {
      case 'ok': status.okRounds++; break
      case 'repaired':
        status.repairedRounds++
        if (round.hasToolResult && !round.hasToolUse) status.orphanToolResult.push(round.id)
        break
      case 'broken':
        status.brokenRounds++
        if (round.hasToolUse && !round.hasToolResult) status.orphanToolUse.push(round.id)
        break
    }
  }

  return status
}

export function getSafeCutIndices(rounds: ApiRound[]): number[] {
  const cuts: number[] = []
  for (const round of rounds) cuts.push(round.endMessageIndex)
  cuts.pop()
  return cuts
}

export function createContextLedger(
  sessionId: string,
  transcriptPath: string,
  messages: Message[],
  contextWindow: number,
): ContextLedger {
  const rounds = groupIntoRounds(messages)
  const estimatedTokens = rounds.reduce((sum, r) => sum + r.tokenEstimate, 0)
  const invariantStatus = computeInvariantStatus(rounds)

  let compactionState: ContextBudget['compactionState'] = 'healthy'
  if (estimatedTokens > contextWindow * 0.95) compactionState = 'critical'
  else if (estimatedTokens > contextWindow * 0.8) compactionState = 'compacting'
  else if (estimatedTokens > contextWindow * 0.5) compactionState = 'warning'

  return {
    sessionId,
    transcriptPath,
    rounds,
    anchors: [],
    workingSet: [],
    compactedSpans: [],
    sessionMemory: null,
    tokenBudget: {
      estimatedTokens,
      maxTokens: contextWindow,
      warningThreshold: Math.floor(contextWindow * 0.5),
      compactionState,
    },
    apiInvariantStatus: invariantStatus,
  }
}

// ─── Tier 1: Microcompact Tool Results ─────────────────────────

export interface MicrocompactOptions {
  keepRecentRounds?: number
  minContentLength?: number
}

export interface MicrocompactResult {
  messages: Message[]
  compactedCount: number
  tokensSaved: number
  compactedRoundIds: string[]
}

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
      const stub = [
        headLine,
        `[compacted: ${lines.length} lines of tool output]`,
        tailLine !== headLine ? tailLine : '',
      ].filter(Boolean).join('\n')

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
  messages: Message[],
  options?: MicrocompactOptions,
): { ledger: ContextLedger; messages: Message[] } {
  const result = microcompactToolResults(messages, options)
  if (result.compactedCount === 0) return { ledger, messages }

  const span: CompactedSpan = {
    id: `micro_${Date.now()}`,
    strategy: 'micro',
    startRoundIndex: 0,
    endRoundIndex: ledger.rounds.length - (options?.keepRecentRounds ?? 4),
    tokenBefore: ledger.tokenBudget.estimatedTokens,
    tokenAfter: ledger.tokenBudget.estimatedTokens - result.tokensSaved,
    rawTranscriptPath: ledger.transcriptPath,
    createdAt: Date.now(),
  }

  const newRounds = groupIntoRounds(result.messages)
  const estimatedTokens = newRounds.reduce((sum, r) => sum + r.tokenEstimate, 0)

  return {
    ledger: {
      ...ledger,
      rounds: newRounds,
      compactedSpans: [...ledger.compactedSpans, span],
      tokenBudget: {
        ...ledger.tokenBudget,
        estimatedTokens,
        compactionState: estimatedTokens > ledger.tokenBudget.maxTokens * 0.8 ? 'compacting' : 'warning',
      },
      apiInvariantStatus: computeInvariantStatus(newRounds),
    },
    messages: result.messages,
  }
}
