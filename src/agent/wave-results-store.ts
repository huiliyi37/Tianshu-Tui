/** Session-scoped cross-wave results bridge.
 *
 *  Wave N+1 dispatch needs the prior wave's WorkerResult[] so dispatchWaveAt can
 *  block tasks whose dependencies failed. This used to live in a per-tool-instance
 *  closure inside team_orchestrate — which silently broke the plan_task → team_orchestrate
 *  bridge: if plan_task ran wave 0 and team_orchestrate ran wave 1, the prior results
 *  never crossed the tool boundary. Keying by sessionId (with a default key for the
 *  single-session TUI / unit tests) lets executePlan carry results across both the
 *  multi-wave loop and the tool boundary.
 */

import type { WorkerResult } from './work-order.js'

const waveResults = new Map<string, WorkerResult[]>()

function key(sessionId?: string): string {
  return sessionId ?? '__default__'
}

/** Record the just-dispatched wave's results for the next wave to read. Overwrites. */
export function setWaveResults(results: WorkerResult[], sessionId?: string): void {
  waveResults.set(key(sessionId), results)
}

/** Read the prior wave's results (undefined when none stored). */
export function getWaveResults(sessionId?: string): WorkerResult[] | undefined {
  return waveResults.get(key(sessionId))
}

/** Clear stored wave results — for test hygiene and explicit session teardown. */
export function clearWaveResults(sessionId?: string): void {
  waveResults.delete(key(sessionId))
}
