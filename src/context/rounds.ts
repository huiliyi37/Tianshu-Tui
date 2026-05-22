import type { ContentBlock, Message } from '../api/types.js'
import type { OaiMessage, OaiAssistantMessage } from '../api/oai-types.js'
import type { ApiInvariant, ApiInvariantStatus, ApiRound } from './types.js'

function estimateMessageTokens(msg: Message): number {
  const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
  return Math.ceil(content.length / 4)
}

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

function estimateCompactableTokens(messages: Message[]): number {
  let tokens = 0
  for (const msg of messages) {
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

        let invariant: ApiInvariant = 'ok'
        if (missingResults.length > 0) {
          invariant = 'broken'
        } else if (orphanResults.length > 0) {
          invariant = 'repaired'
        }

        const tokenEstimate = estimateMessageTokens(msg) + estimateMessageTokens(nextMsg)
        const compactable = estimateCompactableTokens([msg, nextMsg])

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
        compactableTokenEstimate: estimateCompactableTokens([msg]),
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
      case 'ok':
        status.okRounds++
        break
      case 'repaired':
        status.repairedRounds++
        if (round.hasToolResult && !round.hasToolUse) {
          status.orphanToolResult.push(round.id)
        }
        break
      case 'broken':
        status.brokenRounds++
        if (round.hasToolUse && !round.hasToolResult) {
          status.orphanToolUse.push(round.id)
        }
        break
    }
  }

  return status
}

export function getSafeCutIndices(rounds: ApiRound[]): number[] {
  const cuts: number[] = []
  for (const round of rounds) {
    cuts.push(round.endMessageIndex)
  }
  cuts.pop()
  return cuts
}

// ─── OAI-format round grouping ───

function extractOaiToolCallIds(msg: OaiAssistantMessage): string[] {
  if (!msg.tool_calls) return []
  return msg.tool_calls.map(tc => tc.id)
}

function hasOaiToolCalls(msg: OaiMessage): msg is OaiAssistantMessage & { tool_calls: NonNullable<OaiAssistantMessage['tool_calls']> } {
  return msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0
}

function estimateOaiMessageTokens(msg: OaiMessage): number {
  const content = msg.role === 'assistant'
    ? (msg.content ?? '') + (msg.reasoning_content ?? '') + (msg.tool_calls ? JSON.stringify(msg.tool_calls) : '')
    : msg.content
  let ascii = 0, cjk = 0
  for (const ch of content) {
    const code = ch.codePointAt(0) ?? 0
    if ((code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3040 && code <= 0x30FF) || (code >= 0xAC00 && code <= 0xD7AF)) {
      cjk++
    } else {
      ascii++
    }
  }
  return Math.ceil(ascii / 4) + Math.ceil(cjk / 1.5)
}

export interface OaiRound {
  id: string
  startMessageIndex: number
  endMessageIndex: number
  turnNumber: number
  hasToolCalls: boolean
  hasToolResults: boolean
  tokenEstimate: number
  apiInvariant: ApiInvariant
}

export function groupIntoRoundsOai(messages: OaiMessage[]): OaiRound[] {
  const rounds: OaiRound[] = []
  let i = 0
  let roundId = 0
  let turnNumber = 0

  while (i < messages.length) {
    const msg = messages[i]!
    const startIndex = i

    // User text message → single-message round
    if (msg.role === 'user') {
      turnNumber++
      rounds.push({
        id: `round_${roundId++}`,
        startMessageIndex: startIndex,
        endMessageIndex: i + 1,
        turnNumber,
        hasToolCalls: false,
        hasToolResults: false,
        tokenEstimate: estimateOaiMessageTokens(msg),
        apiInvariant: 'ok',
      })
      i++
      continue
    }

    // Assistant without tool_calls → single-message round
    if (msg.role === 'assistant' && !hasOaiToolCalls(msg)) {
      rounds.push({
        id: `round_${roundId++}`,
        startMessageIndex: startIndex,
        endMessageIndex: i + 1,
        turnNumber,
        hasToolCalls: false,
        hasToolResults: false,
        tokenEstimate: estimateOaiMessageTokens(msg),
        apiInvariant: 'ok',
      })
      i++
      continue
    }

    // Assistant with tool_calls → look for matching tool responses
    if (msg.role === 'assistant' && hasOaiToolCalls(msg)) {
      const toolCallIds = extractOaiToolCallIds(msg)
      const resultIds: string[] = []
      let j = i + 1

      // Collect consecutive tool messages
      while (j < messages.length && messages[j]!.role === 'tool') {
        const toolMsg = messages[j]!
        if (toolMsg.role === 'tool') {
          resultIds.push(toolMsg.tool_call_id)
        }
        j++
      }

      const missingResults = toolCallIds.filter(id => !resultIds.includes(id))
      const orphanResults = resultIds.filter(id => !toolCallIds.includes(id))

      let invariant: ApiInvariant = 'ok'
      if (missingResults.length > 0) {
        invariant = 'broken'
      } else if (orphanResults.length > 0) {
        invariant = 'repaired'
      }

      // Estimate tokens for the whole round
      let tokenEst = 0
      for (let idx = startIndex; idx < j; idx++) {
        tokenEst += estimateOaiMessageTokens(messages[idx]!)
      }

      rounds.push({
        id: `round_${roundId++}`,
        startMessageIndex: startIndex,
        endMessageIndex: j,
        turnNumber,
        hasToolCalls: true,
        hasToolResults: resultIds.length > 0,
        tokenEstimate: tokenEst,
        apiInvariant: invariant,
      })
      i = j
      continue
    }

    // Orphan tool message → single-message round
    if (msg.role === 'tool') {
      rounds.push({
        id: `round_${roundId++}`,
        startMessageIndex: startIndex,
        endMessageIndex: i + 1,
        turnNumber,
        hasToolCalls: false,
        hasToolResults: true,
        tokenEstimate: estimateOaiMessageTokens(msg),
        apiInvariant: 'repaired',
      })
      i++
      continue
    }

    // System or other → single-message round
    rounds.push({
      id: `round_${roundId++}`,
      startMessageIndex: startIndex,
      endMessageIndex: i + 1,
      turnNumber,
      hasToolCalls: false,
      hasToolResults: false,
      tokenEstimate: estimateOaiMessageTokens(msg),
      apiInvariant: 'ok',
    })
    i++
  }

  return rounds
}

export function computeOaiInvariantStatus(rounds: OaiRound[]): ApiInvariantStatus {
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
      case 'ok':
        status.okRounds++
        break
      case 'repaired':
        status.repairedRounds++
        if (round.hasToolResults && !round.hasToolCalls) {
          status.orphanToolResult.push(round.id)
        }
        break
      case 'broken':
        status.brokenRounds++
        if (round.hasToolCalls && !round.hasToolResults) {
          status.orphanToolUse.push(round.id)
        }
        break
    }
  }

  return status
}
