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
  if (messages.length <= CACHE_ANCHOR_MESSAGES) return messages
  return messages.map((msg, idx) => {
    if (idx === CACHE_ANCHOR_MESSAGES - 1) {
      return { ...msg, cache_control: { type: 'ephemeral' as const } }
    }
    return msg
  })
}
