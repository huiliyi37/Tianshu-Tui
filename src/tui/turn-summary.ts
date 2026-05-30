import type { PhaseSegment } from '../agent/chronicle.js'
import { PHASE_GLYPHS } from '../agent/star-event.js'

export interface TurnSummaryInput {
  segments: PhaseSegment[]
  filesRead: number
  filesModified: number
  verifiedCount: number
  elapsedMs: number
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m${s % 60}s`
}

/** One-line git-log-style anchor: phase trail · files · verify · duration. */
export function formatTurnSummary(input: TurnSummaryInput): string {
  const trail = input.segments.map(s => PHASE_GLYPHS[s.phase]).join(' → ')
  const parts: string[] = []
  if (trail) parts.push(trail)
  parts.push(`读${input.filesRead} 改${input.filesModified}`)
  if (input.verifiedCount > 0) parts.push(`✓${input.verifiedCount}`)
  parts.push(fmtDuration(input.elapsedMs))
  return parts.join(' · ')
}
