/** Session-scoped plan bridge: plan_task → team_orchestrate.
 *
 *  plan_task writes the serialized UnifiedPlan here after generation.
 *  team_orchestrate reads (and re-stores for multi-wave) when planJson
 *  is omitted.  This eliminates the anti-pattern of asking the model to
 *  copy-paste structured JSON between tool calls.
 *
 *  Module-level singleton — scoped to one agent session.  storePlan
 *  always overwrites the previous plan, so stale plans cannot leak
 *  across independent plan_task invocations.
 */

let storedPlan: string | null = null

/** Store a serialized UnifiedPlan for later retrieval by team_orchestrate.
 *  Overwrites any previously stored plan. */
export function storePlan(json: string): void {
  storedPlan = json
}

/** Consume and clear the stored plan.  Returns null if none stored.
 *  Callers that need multi-wave continuity should re-store after consuming. */
export function consumePlan(): string | null {
  const plan = storedPlan
  storedPlan = null
  return plan
}

/** Peek without consuming — for diagnostics only. */
export function getStoredPlan(): string | null {
  return storedPlan
}
