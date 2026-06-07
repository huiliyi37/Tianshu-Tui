import type { OaiMessage } from '../api/oai-types.js'
import { createLogEntry, type LogEntry } from './log-state.js'

export interface ReplayResult {
  entries: LogEntry[]
  toolCount: number
  turnCount: number
}

export function replayMessagesToLogEntries(messages: OaiMessage[]): ReplayResult {
  const entries: LogEntry[] = []
  let toolCount = 0
  let turnCount = 0

  // Build tool-name map from assistant messages' tool_calls
  const toolNameMap = new Map<string, string>()
  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        toolNameMap.set(tc.id, tc.function.name)
      }
    }
  }

  for (const msg of messages) {
    // User text message
    if (msg.role === 'user') {
      // TTSR injects guardrail reminders as system-reminder-wrapped user
      // messages (user role keeps the prompt-cache prefix intact). Render
      // these as system notices, not user bubbles.
      if (typeof msg.content === 'string' && msg.content.startsWith('<system-reminder>')) {
        const inner = msg.content
          .replace(/^<system-reminder>\n?/, '')
          .replace(/\n?<\/system-reminder>$/, '')
        entries.push(createLogEntry({ type: 'system', content: inner, turnNumber: turnCount }))
        continue
      }
      turnCount++
      entries.push(createLogEntry({ type: 'user_message', content: msg.content, turnNumber: turnCount }))
      continue
    }

    // Assistant message — split thinking into separate entry
    if (msg.role === 'assistant') {
      const text = msg.content ?? ''
      const thinking = msg.reasoning_content ?? ''
      if (thinking) {
        entries.push(createLogEntry({
          type: 'thinking_message',
          content: thinking,
          turnNumber: turnCount,
        }))
      }
      if (text) {
        entries.push(createLogEntry({
          type: 'assistant_message',
          content: text,
          turnNumber: turnCount,
        }))
      }
      continue
    }

    // Tool result message
    if (msg.role === 'tool') {
      entries.push(createLogEntry({
        type: 'tool',
        content: msg.content,
        isError: false,
        toolName: toolNameMap.get(msg.tool_call_id),
        turnNumber: turnCount,
      }))
      toolCount++
      continue
    }

    // System messages — skip gracefully
  }

  return { entries, toolCount, turnCount }
}
