import type { Message } from './types.js'
import type { ProviderProfile } from './provider-profile.js'
import { CACHE_ANCHOR_MESSAGES } from '../compact/constants.js'

export function applyCacheStrategy(messages: Message[], profile: ProviderProfile): Message[] {
  switch (profile.cacheType) {
    case 'exact-prefix':
    case 'none':
    case 'block-kv':
      return messages
    case 'explicit-breakpoint':
      return applyExplicitBreakpoints(messages, profile)
    case 'partial-prefix':
      return messages
  }
}

function applyExplicitBreakpoints(messages: Message[], _profile: ProviderProfile): Message[] {
  if (messages.length === 0) return messages

  // Find frozen/working zone boundary:
  // Scan backward from the end, skip trailing user messages,
  // the last assistant before them is the boundary.
  let boundaryIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'assistant') {
      boundaryIdx = i
      break
    }
  }

  // Fallback for single-turn (no assistant yet): use fixed anchor
  if (boundaryIdx < 0) {
    boundaryIdx = Math.min(CACHE_ANCHOR_MESSAGES - 1, messages.length - 1)
  }

  return messages.map((msg, idx) => {
    if (idx === boundaryIdx) {
      return { ...msg, cache_control: { type: 'ephemeral' as const } }
    }
    return msg
  })
}
