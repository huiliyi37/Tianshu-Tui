/**
 * T2-02 P3: Pure effort-delta resolution logic.
 *
 * Extracted from AgentLoop.applyEffortDelta so the clamp + reasoningFloor
 * safety gate can be unit-tested in isolation (the live method also pulls in
 * a real bandit via getEffortDelta(), which is hard to control in a test).
 *
 * Behavior must stay identical to the inlined logic it replaces:
 *  - delta null/0            → baseEffort unchanged
 *  - baseEffort not in order → baseEffort unchanged
 *  - idx+delta out of bounds → clamped to [0, max]
 *  - reasoningFloor set and resulting idx < floorIdx → baseEffort (no drop)
 */

export const EFFORT_ORDER = ['off', 'low', 'medium', 'high', 'max'] as const
export type EffortLevel = typeof EFFORT_ORDER[number]

/**
 * Resolve a new effort level by applying `delta` to `baseEffort`, clamped to
 * the valid range and never falling below `floor` when one is configured.
 * Returns `baseEffort` unchanged on any guard condition.
 */
export function resolveEffortDelta(
  baseEffort: string,
  delta: number | null,
  floor?: string,
): string {
  if (delta === null || delta === 0) return baseEffort
  const idx = EFFORT_ORDER.indexOf(baseEffort as EffortLevel)
  if (idx === -1) return baseEffort
  const newIdx = Math.max(0, Math.min(EFFORT_ORDER.length - 1, idx + delta))
  const newEffort = EFFORT_ORDER[newIdx]!
  // reasoningFloor gate: never drop below floor
  if (floor) {
    const floorIdx = EFFORT_ORDER.indexOf(floor as EffortLevel)
    if (floorIdx >= 0 && newIdx < floorIdx) return baseEffort
  }
  return newEffort
}
