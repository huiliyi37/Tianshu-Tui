import { buildExecutionGuidance, type GuidanceTrajectoryEntry } from './execution-guidance.js'

export type TrajectorySummary = GuidanceTrajectoryEntry

export function suggestStrategyShift(trajectory: TrajectorySummary[], doomLevel: 'none' | 'warn' | 'blocked'): string | null {
  return buildExecutionGuidance({ trajectory, doomLevel })?.message ?? null
}
