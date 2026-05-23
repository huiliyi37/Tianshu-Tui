/**
 * Detect "lesson learned" moments: when a tool just transitioned from failed to passed.
 *
 * Used to wire MistakeNotebook's write path: read path is already in tool-pipeline,
 * but recordMistake was never called. This pure function scans the trace store
 * to find the most recent failed event of the same tool, ensuring we only learn
 * a mistake once (skip if already resolved by an intervening passed).
 */

import type { TraceStore } from './trace-store.js'

export interface MistakeResolution {
  /** The error summary from the prior failed event */
  error: string
  /** Context: the tool name that failed and was just resolved */
  context: string
}

/**
 * If the event identified by currentTraceId is a passed tool event AND there
 * is an earlier failed event for the same tool that has not yet been resolved
 * (no passed event between them), return the resolution. Otherwise return null.
 */
export function detectMistakeResolution(
  store: TraceStore,
  currentTraceId: string,
  currentToolName: string,
): MistakeResolution | null {
  const events = store.events
  // Find current event index
  const currentIdx = events.findIndex(e => e.id === currentTraceId)
  if (currentIdx < 0) return null

  const current = events[currentIdx]!
  if (current.status !== 'passed') return null

  // Walk backward to find most recent same-tool event
  for (let i = currentIdx - 1; i >= 0; i--) {
    const prior = events[i]!
    if (prior.name !== currentToolName) continue
    // Found a same-tool event. If it passed, the earlier failure (if any)
    // was already resolved — no new lesson here.
    if (prior.status === 'passed') return null
    if (prior.status === 'failed') {
      return {
        error: prior.summary ?? '(no summary)',
        context: currentToolName,
      }
    }
    // Other statuses (running, blocked) — keep walking
  }

  return null
}
