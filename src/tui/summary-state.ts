import type { Phase, LastAction } from './phase-tracker.js'
import { PHASE_SHORT_LABELS, type StarPhase } from '../agent/star-event.js'
import type { TaskListItem } from '../agent/session-state.js'
import type { ReasoningEffort } from '../agent/auto-reasoning.js'

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
  /** 持久化的任务列表（从 Assistant 回复中提取），用于底部固定面板显示 */
  taskList?: readonly TaskListItem[]
  /** Current reasoning effort level shown in status bar */
  reasoningEffort?: ReasoningEffort
}

export function phaseFromSummary(state: SummaryState): StarPhase {
  if (!state.starPhaseLabel) return 'tianshu-planning'
  return (Object.entries(PHASE_SHORT_LABELS).find(([, v]) => v === state.starPhaseLabel)?.[0] as StarPhase | undefined) ?? 'tianshu-planning'
}
