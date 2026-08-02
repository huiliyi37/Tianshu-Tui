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
 * Whether Phase 2A routine effort routing is active.
 *
 * Default ON (cost control): routine on-track turns step effort down one tier.
 * Opt out with `RIVET_EFFORT_ROUTING=0` (also accepts `false` / `off`).
 * Explicit `=1` / `true` / `on` keeps the historical opt-in spelling working.
 */
export function isEffortRoutingEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env['RIVET_EFFORT_ROUTING']
  if (raw === undefined || raw === '') return true
  const v = raw.trim().toLowerCase()
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return false
  if (v === '1' || v === 'true' || v === 'on' || v === 'yes') return true
  // Unknown values: fail open to the cost-saving default.
  return true
}

/**
 * Phase 2A: route reasoning effort down one tier on routine, on-track turns.
 *
 * Default ON — DeepSeek V4 bills thinking inside output tokens; stepping down
 * on low-complexity turns is the highest-ROI cost lever after prefix cache.
 * Opt out: `RIVET_EFFORT_ROUTING=0`.
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
  enabled: boolean = isEffortRoutingEnabled(),
): ReasoningEffort {
  if (!enabled) return effort
  const routine = signals.complexity <= 0.3 && (signals.momentum >= 0.7 || signals.confidence >= 0.7)
  if (!routine) return effort
  const idx = ORDER.indexOf(effort)
  if (idx <= 0) return effort
  return ORDER[idx - 1]!
}
