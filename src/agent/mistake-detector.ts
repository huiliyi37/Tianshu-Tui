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
/**
 * Sanitize a tool input before it is recorded as a MistakeNotebook resolution.
 *
 * File-state-specific parameters are one-shot coordinates: they are only valid
 * for the exact file bytes they were harvested from. Replaying them verbatim
 * inside a <mistake-hints> "Resolution:" block teaches the model to copy dead
 * parameters on the next failure (2026-07-06 TDX session looped exactly this
 * way on hash_edit anchors). Strip them; keep the rest of the shape (file_path,
 * new_string, flags) so the hint still shows WHAT kind of call resolved the
 * error.
 *
 * Covered per tool:
 *  - hash_edit.anchors   — L<line>:<hash> pairs, dead after any file change
 *  - edit_file.old_string — exact-match text, dead after the very edit that
 *    succeeded (and after any later change); new_string stays (it is the
 *    desired content, not a coordinate)
 *  - apply_patch.diff    — unified-diff context lines are positional anchors,
 *    dead after application
 *
 * ast_edit is deliberately NOT sanitized: its find patterns are structural
 * (`var $NAME = $VAL`), not file-state coordinates — replaying them is fine.
 */
export function sanitizeMistakeResolutionInput(
  toolName: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (toolName === 'hash_edit' && 'anchors' in input) {
    return { ...input, anchors: '<one-shot, re-harvest via grep>' }
  }
  if (toolName === 'edit_file' && 'old_string' in input) {
    return { ...input, old_string: '<file-state-specific, re-match against current content>' }
  }
  if (toolName === 'apply_patch' && 'diff' in input) {
    return { ...input, diff: '<file-state-specific patch, regenerate from current content>' }
  }
  return input
}

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
