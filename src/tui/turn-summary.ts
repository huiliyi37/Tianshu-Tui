import type { PhaseSegment } from '../agent/chronicle.js'
import { PHASE_GLYPHS } from '../agent/star-event.js'

export interface TurnSummaryInput {
  turnNumber: number
  segments: PhaseSegment[]
  filesRead: number
  filesModified: number
  verifiedCount: number
  elapsedMs: number
}

/** Compact per-turn history marker: phase trail · files · verify.
 *  Turn number and elapsed are intentionally omitted here — the live footer
 *  (GlanceBar) owns elapsed, and the turn count is sequential noise in
 *  scrollback. What remains is the durable "what this turn touched" anchor. */
export function formatTurnSummary(input: TurnSummaryInput): string {
  const trail = input.segments.map(s => PHASE_GLYPHS[s.phase]).join(' → ')
  const parts: string[] = []
  if (trail) parts.push(trail)
  parts.push(`读${input.filesRead} 改${input.filesModified}`)
  if (input.verifiedCount > 0) parts.push(`✓${input.verifiedCount}`)
  return parts.join(' · ')
}
