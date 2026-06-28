/** Session-scoped plan bridge: plan_task → team_orchestrate.
 *
 *  plan_task writes the serialized UnifiedPlan here after generation.
 *  team_orchestrate reads (and re-stores for multi-wave) when planJson
 *  is omitted.  This eliminates the anti-pattern of asking the model to
 *  copy-paste structured JSON between tool calls.
 *
 *  Internally keyed by sessionId so concurrent/forked sessions don't share
 *  the same stored plan.  A fallback default key is used when no session is
 *  set, keeping unit tests simple.
 */

const plans = new Map<string, string>()
let currentSessionId: string | undefined

function currentKey(sessionId?: string): string {
  return sessionId ?? currentSessionId ?? '__default__'
}

/** Set the current session for callers that don't (or can't) pass a sessionId. */
export function setPlanSession(sessionId: string): void {
  currentSessionId = sessionId
}

/** Store a serialized UnifiedPlan for later retrieval by team_orchestrate.
 *  Overwrites any previously stored plan for the target session. */
export function storePlan(json: string, sessionId?: string): void {
  plans.set(currentKey(sessionId), json)
}

/** Consume and clear the stored plan.  Returns null if none stored.
 *  Callers that need multi-wave continuity should re-store after consuming. */
export function consumePlan(sessionId?: string): string | null {
  const key = currentKey(sessionId)
  const plan = plans.get(key) ?? null
  plans.delete(key)
  return plan
}

/** Peek without consuming — for diagnostics only. */
export function getStoredPlan(sessionId?: string): string | null {
  return plans.get(currentKey(sessionId)) ?? null
}

/** Explicitly drop any stored plan for the session. Use when a caller supplies
 *  its own plan and a stale stored plan must not leak into a later bare call. */
export function clearPlan(sessionId?: string): void {
  plans.delete(currentKey(sessionId))
}
