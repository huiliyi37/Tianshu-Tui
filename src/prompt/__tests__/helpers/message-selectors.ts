import type { OaiMessage } from '../../../api/oai-types.js'

export interface LatestUserTrailer {
  fresh: string
  user: string
  message: OaiMessage
}

export function latestUserTrailer(messages: readonly OaiMessage[]): LatestUserTrailer {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.role === 'user' && typeof msg.content === 'string') {
      const sep = '\n---\n'
      const idx = msg.content.indexOf(sep)
      // Skip standalone appendix messages (no trailer separator)
      if (idx === -1) continue
      return { fresh: msg.content.slice(0, idx), user: msg.content.slice(idx + sep.length), message: msg }
    }
  }
  throw new Error('expected at least one user message with trailer separator')
}

export function userMessages(messages: readonly OaiMessage[]): OaiMessage[] {
  return messages.filter(m => m.role === 'user')
}

export function toolMessages(messages: readonly OaiMessage[]): OaiMessage[] {
  return messages.filter(m => m.role === 'tool')
}
