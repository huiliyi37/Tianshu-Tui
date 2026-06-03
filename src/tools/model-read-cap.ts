/**
 * Per-call cap on how much of a tool's raw output is sent to the model.
 *
 * Background: read_file and grep historically returned at most 8 000 characters
 * to the model regardless of context window or provider strategy. On a 200 K
 * window that is ~4 % of capacity; on a 1 M window it is < 1 %. The model
 * silently saw a head/tail slice of any non-trivial source file with the
 * middle elided, which made code reasoning unreliable and in many cases
 * indistinguishable from "the file is short."
 *
 * This module computes a per-tool-call character budget that scales with the
 * context window and the provider's caching strategy. Callers (read_file,
 * grep) pass the result into {@link truncateContent}; on legacy callers that
 * do not yet plumb config through, {@link DEFAULT_MODEL_READ_CAP} keeps the
 * old 8 000-char behaviour as a hard floor.
 */
import type { ProviderProfile } from '../api/provider-profile.js'
import { compactProviderStrategy } from '../compact/constants.js'

export interface ModelReadCap {
  /** Total characters retained when content is truncated. */
  maxChars: number
  /** Characters kept at the head of the content. */
  headChars: number
  /** Characters kept at the tail of the content. */
  tailChars: number
}

/** Legacy floor — matches the historical 8 000 / 4 000 / 2 000 split. */
export const DEFAULT_MODEL_READ_CAP: ModelReadCap = {
  maxChars: 8_000,
  headChars: 4_000,
  tailChars: 2_000,
}

/** Hard ceiling: anything bigger should go through the artifact store. */
const ABSOLUTE_MAX_CHARS = 200_000

/**
 * Fraction of the context window allocated to a single tool result that is
 * shown verbatim to the model.
 *
 * Larger windows can afford 5% per call; smaller windows need more conservative
 * budgets to prevent a handful of read_file calls from consuming the entire
 * context. The breakpoints align with pruneThresholds' window tiers so the
 * read cap and prune/exemption logic stay coherent.
 *
 * Multiplied by CHARS_PER_TOKEN (4) to convert tokens → characters.
 */
function tokenFractionPerCall(contextWindow: number): number {
  if (contextWindow >= 500_000) return 0.05  // ≥500K: 5% — ample room
  if (contextWindow >= 200_000) return 0.03  // 200K–500K: 3%
  return 0.02                                 // <200K: 2%
}
const CHARS_PER_TOKEN = 4

/** Strategy multiplier — cache-preserving providers can afford to send more
 *  in a single call because compaction is more expensive there, so we'd
 *  rather give the model a complete picture up front than re-read later. */
const STRATEGY_MULTIPLIER: Record<ReturnType<typeof compactProviderStrategy>, number> = {
  'cache-preserving': 1.3,
  balanced: 1.0,
  aggressive: 0.65,
}

export interface ModelReadCapInput {
  contextWindow?: number
  providerProfile?: Pick<ProviderProfile, 'cacheType' | 'persistent'>
}

/**
 * Compute the read cap for a single tool call.
 *
 * - Returns {@link DEFAULT_MODEL_READ_CAP} when no contextWindow is supplied
 *   (back-compat path for callers that haven't plumbed config through).
 * - Always returns at least the default 8 000 characters — never tighter
 *   than legacy behaviour.
 * - Caps at {@link ABSOLUTE_MAX_CHARS}. Beyond that, callers should rely on
 *   the artifact store for the full content.
 *
 * Head/tail split is 60 % / 30 % of the total cap, leaving 10 % buffer for
 * the truncation marker line.
 */
export function computeModelReadCap(input: ModelReadCapInput = {}): ModelReadCap {
  const { contextWindow, providerProfile } = input
  if (!contextWindow || contextWindow <= 0) {
    return DEFAULT_MODEL_READ_CAP
  }

  const strategy = compactProviderStrategy(providerProfile)
  const multiplier = STRATEGY_MULTIPLIER[strategy]

  const fraction = tokenFractionPerCall(contextWindow)
  const computed = Math.floor(contextWindow * fraction * CHARS_PER_TOKEN * multiplier)
  const maxChars = Math.min(Math.max(computed, DEFAULT_MODEL_READ_CAP.maxChars), ABSOLUTE_MAX_CHARS)

  return {
    maxChars,
    headChars: Math.floor(maxChars * 0.6),
    tailChars: Math.floor(maxChars * 0.3),
  }
}
