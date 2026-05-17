import type { Message, MessageRequest } from './types.js'
import type { ProviderProfile } from './provider-profile.js'
import { applyCacheStrategy } from './cache-strategy.js'

/**
 * Deep-strip unsupported params from a MessageRequest at all levels.
 *
 * Unlike the existing top-level strip (client.ts:stripUnsupported),
 * this also cleans:
 * - Message-level: cache_control on individual messages
 * - Tool-schema-level: provider-unsupported metadata
 *
 * For exact-prefix providers (DeepSeek), this is critical:
 * Anthropic-style cache_control fields in messages break byte-level prefix match.
 */
export function deepStripUnsupported(
  request: MessageRequest,
  unsupported: string[],
): MessageRequest {
  if (unsupported.length === 0) return request

  // Top-level strip
  const req = { ...request }
  for (const field of unsupported) {
    delete (req as Record<string, unknown>)[field]
  }

  // Message-level strip: remove cache_control from individual messages
  if (unsupported.includes('cache_control')) {
    req.messages = req.messages.map(m => {
      const { cache_control: _, ...rest } = m as Message & { cache_control?: unknown }
      return rest as Message
    })
  }

  return req
}

/**
 * Canonicalize a MessageRequest for cache stability.
 *
 * Applies:
 * 1. Deep param normalization (strip unsupported at all levels)
 * 2. Cache strategy application (provider-specific cache_control injection)
 *
 * For exact-prefix providers (DeepSeek): ensures no cache_control leaks
 *   and messages remain byte-stable for prefix match.
 * For explicit-breakpoint providers (Anthropic): injects cache_control
 *   at the canonical anchor point.
 *
 * Pure function — deterministic, no side effects.
 */
export function canonicalizeRequest(
  request: MessageRequest,
  profile: ProviderProfile,
  unsupported: string[],
): MessageRequest {
  // Step 1: Deep strip unsupported params
  const stripped = deepStripUnsupported(request, unsupported)

  // Step 2: Apply cache strategy to messages
  const messages = applyCacheStrategy(stripped.messages, profile)

  return { ...stripped, messages }
}
