import type { Message, ContentBlock, ContentBlockToolResult } from '../api/types.js'
import { createLogEntry, type LogEntry } from './log-state.js'

export interface ReplayResult {
  entries: LogEntry[]
  toolCount: number
  turnCount: number
}

export function replayMessagesToLogEntries(messages: Message[]): ReplayResult {
  const entries: LogEntry[] = []
  let toolCount = 0
  let turnCount = 0

  const toolNameMap = new Map<string, string>()
  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content as ContentBlock[]) {
        if (block.type === 'tool_use') {
          toolNameMap.set(block.id, block.name)
        }
      }
    }
  }

  for (const msg of messages) {
    if (msg.role === 'user' && typeof msg.content === 'string') {
      turnCount++
      entries.push(createLogEntry({ type: 'user_message', content: msg.content, turnNumber: turnCount }))
      continue
    }

    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content as ContentBlock[]) {
        if (block.type === 'text') {
          entries.push(createLogEntry({ type: 'assistant_message', content: block.text, turnNumber: turnCount }))
        }
      }
      continue
    }

    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (const block of msg.content as ContentBlock[]) {
        if (block.type === 'tool_result') {
          const tb = block as ContentBlockToolResult
          entries.push(createLogEntry({
            type: 'tool',
            content: tb.content,
            isError: tb.is_error ?? false,
            toolName: toolNameMap.get(tb.tool_use_id),
            turnNumber: turnCount,
          }))
          toolCount++
        }
      }
    }
  }

  return { entries, toolCount, turnCount }
}
