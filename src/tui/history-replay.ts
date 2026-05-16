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

  for (const msg of messages) {
    if (msg.role === 'user' && typeof msg.content === 'string') {
      turnCount++
      entries.push(createLogEntry({ type: 'user_message', content: msg.content }))
      continue
    }

    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content as ContentBlock[]) {
        if (block.type === 'text') {
          entries.push(createLogEntry({ type: 'assistant_message', content: block.text }))
        } else if (block.type === 'tool_use') {
          // tool_use blocks are counted only when their result arrives below
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
          }))
          toolCount++
        }
      }
    }
  }

  return { entries, toolCount, turnCount }
}
