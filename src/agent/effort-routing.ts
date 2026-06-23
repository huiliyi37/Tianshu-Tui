import type { ReasoningEffort } from './auto-reasoning.js'

const ORDER: ReasoningEffort[] = ['off', 'low', 'medium', 'high', 'max']

export interface RoutineEffortSignals {
  /** Tool-call-history complexity, 0..1 (high = many distinct/heavy tools). */
  complexity: number
  /** Prediction-accuracy momentum, 0..1 (high = the agent is on track). */
  momentum: number
  /** Evidence-coverage confidence, 0..1 (high = well-grounded). */
  confidence: number
}

/**
 * Phase 2A: route reasoning effort down one tier on routine, on-track turns.
 *
 * OPT-IN via RIVET_EFFORT_ROUTING=1 — OFF by default. This is an unvalidated
 * behavior change gated on the Phase 1 decision (reasoning-dominated output).
 * Keeping it opt-in means the default session is byte-for-byte unchanged until
 * the data justifies enabling it.
 *
 * Heuristic: a turn is "routine" when complexity is low AND the agent is on
 * track (high prediction momentum or good evidence coverage). Such turns rarely
 * need deep reasoning, so we step effort down one notch to save thinking tokens.
 * Anything ambiguous keeps full effort — we never step UP here.
 *
 * The reasoning floor is intentionally NOT enforced in this function;
 * {@link ReasoningEffortController.set} clamps the result to the configured
 * floor downstream, so a single floor implementation stays authoritative.
 */
export function routeRoutineEffort(
  effort: ReasoningEffort,
  signals: RoutineEffortSignals,
  enabled: boolean = process.env['RIVET_EFFORT_ROUTING'] === '1',
): ReasoningEffort {
  if (!enabled) return effort
  const routine = signals.complexity <= 0.3 && (signals.momentum >= 0.7 || signals.confidence >= 0.7)
  if (!routine) return effort
  const idx = ORDER.indexOf(effort)
  if (idx <= 0) return effort
  return ORDER[idx - 1]!
}
