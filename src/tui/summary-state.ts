import type { Phase, LastAction } from './phase-tracker.js'
import { PHASE_SHORT_LABELS, type StarPhase } from '../agent/star-event.js'

export interface SummaryState {
  task: string
  phase: Phase
  stepCount: number
  totalSteps: number
  contextPct: number
  elapsedMs: number
  lastAction: LastAction | null
  risk: 'none' | 'medium' | 'high'
  compactEvent?: { beforeTokens: number; afterTokens: number } | null
  approvalNeeded?: { tool: string; target: string } | null
  tokenHistory?: number[]
  /** How long the current phase has been running (ms) */
  phaseDurationMs?: number
  /** Current turn / max turns */
  turnCount?: number
  maxTurns?: number
  // 天枢之眼 — star phase + alchemy
  starPhaseGlyph?: string
  starPhaseLabel?: string
  alchemyConfidence?: number
  recentToolSummary?: string[]
}

export function phaseFromSummary(state: SummaryState): StarPhase {
  if (!state.starPhaseLabel) return 'tianshu-planning'
  return (Object.entries(PHASE_SHORT_LABELS).find(([, v]) => v === state.starPhaseLabel)?.[0] as StarPhase | undefined) ?? 'tianshu-planning'
}
