/**
 * Void identity — the mark an agent leaves on the constellation.
 *
 * Philosophy (占卜模型): the star domain summons an agent into being for a task.
 * It begins void and nameless. As it works it lays down a trajectory only it
 * knows. When it departs, it leaves a mark — a symbol it chooses for itself,
 * any glyph. We do not assign the symbol, nor record the trajectory. Next time
 * a kindred agent reads the starmap and recognises that symbol, it knows it has
 * returned (同气相求 — recognition is emergent, not computed).
 *
 * So this module is deliberately small: mint an ephemeral id, sanitize the
 * agent's chosen symbol, and build the AgentMark. No fingerprint hashing, no
 * deterministic symbol derivation.
 */
import { randomInt as cryptoRandomInt } from 'node:crypto'
import type { AgentMark } from '../constellation/schema.js'

/** Void symbol — an unsigned / anonymous journey (agent left no mark). */
export const VOID_SYMBOL = '·'

/** Suggested palette surfaced to agents in the leave ritual (they may pick any glyph). */
export const VOID_GLYPHS: readonly string[] = [
  '✦', '✧', '✶', '✷', '✸', '✺', '❂', '❉',
  '◈', '◇', '⟡', '⌬', '⚘', '⚙', '⊕', '↻',
]

/** Mint an ephemeral per-session numeric id (1000–9999). Injectable for tests. */
export function mintNumericId(randomInt?: () => number): number {
  return randomInt ? randomInt() : cryptoRandomInt(1000, 10000)
}

/**
 * Sanitize an agent-supplied symbol: trim, cap to 2 visible chars, fall back to
 * the void symbol when empty. We accept *any* glyph — the choice is the agent's.
 */
export function sanitizeSymbol(raw: unknown): string {
  if (typeof raw !== 'string') return VOID_SYMBOL
  const trimmed = raw.trim()
  if (!trimmed) return VOID_SYMBOL
  return [...trimmed].slice(0, 2).join('')
}

/** Build the persisted mark from a chosen symbol + domain. */
export function buildAgentMark(input: {
  numericId?: number
  symbol: string
  domain?: string
  randomInt?: () => number
}): AgentMark {
  return {
    numericId: input.numericId ?? mintNumericId(input.randomInt),
    symbol: sanitizeSymbol(input.symbol),
    domain: input.domain ?? '',
  }
}

/** Render-ready display name, e.g. "yaoguang·#7281·⚘". */
export function formatMarkName(mark: AgentMark): string {
  return `${mark.domain ? mark.domain + '·' : ''}#${mark.numericId}·${mark.symbol}`
}
