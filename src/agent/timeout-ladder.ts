/**
 * Sub-agent timeout ladder — single source of truth + invariant.
 *
 * ## Invariant
 * `SSE_idle < worker_budget ≤ tool_timeout ≤ heartbeat_hardStall`
 *
 * Meaning: a stalled SSE stream surfaces before the worker budget;
 * the tool timeout never aborts a worker mid-flight (budget ≤ tool);
 * hardStall is the outermost safety net.
 *
 * ## Arithmetic progressive curve
 * Common difference = 60 s, per user requirement:
 *   turn  0–1 (cold open)  →  60 s
 *   turn  2–4 (warming)    → 120 s
 *   turn  5+  (mature)     → 180 s
 */

/** Worker-session SSE idle ceiling.
 *
 * Deliberately shorter than the main session's reasoning-read idle (180 s)
 * so a stalled worker stream surfaces before the worker budget — keeps the
 * ladder invariant.  The main session can afford long idles (deep reasoning),
 * but a worker is a bounded sub-task: silence past 45 s should trigger
 * investigation, not patient waiting. */
export const WORKER_SSE_IDLE_MS = 45_000

/** Canonical SSE idle exposed for invariant assertions. */
export const SSE_IDLE_MS = WORKER_SSE_IDLE_MS

/** Hard-stall watchdog ceiling.
 *  Matches {@link TurnHeartbeat} `hardStallMs` (`loop.ts`). */
export const HARD_STALL_MS = 240_000

/** Default worker budget (matches `work-order.ts` default `timeoutMs`). */
export const DEFAULT_WORKER_BUDGET_MS = 180_000

/** Arithmetic progressive timeout.
 * @param sessionTurnCount current session turn (0-based). Defaults to mature.
 * @returns cold=60s, warming=120s, mature=180s — common difference 60s. */
export function progressiveTimeout(sessionTurnCount?: number): number {
  const turn = sessionTurnCount ?? 10
  if (turn <= 1) return 60_000
  if (turn <= 4) return 120_000
  return 180_000
}

export interface LadderConfig {
  sseIdle: number
  budget: number
  tool: number
  hardStall: number
}

/** Throw if the ladder invariant is violated.
 *
 * Call at coordinator startup or in tests to catch misconfiguration early.
 *
 * Invariant: `sseIdle < budget ≤ tool ≤ hardStall`. */
export function assertLadderInvariant(c: LadderConfig): void {
  if (!(c.sseIdle < c.budget))
    throw new Error(`ladder: SSE idle(${c.sseIdle}) must be < budget(${c.budget})`)
  if (!(c.budget <= c.tool))
    throw new Error(`ladder: budget(${c.budget}) must be ≤ tool(${c.tool})`)
  if (!(c.tool <= c.hardStall))
    throw new Error(`ladder: tool(${c.tool}) must be ≤ hardStall(${c.hardStall})`)
}

/** Cap worker budget at the tool-level timeout so the tool never aborts a
 *  worker mid-flight.  Returns `min(budget, toolTimeoutMs)`.
 *
 *  When `toolTimeoutMs` is undefined (no per-call override), returns the
 *  budget unchanged — the global abortSignal propagation handles the cap. */
export function capBudgetAtTool(budgetMs: number, toolTimeoutMs?: number): number {
  if (toolTimeoutMs === undefined) return budgetMs
  return Math.min(budgetMs, toolTimeoutMs)
}
