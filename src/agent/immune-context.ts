/**
 * Immune Context Injector
 *
 * Bridges the Immune system's learned patterns with the agent's context window.
 * When Immune activates, this module queries the MistakeNotebook for related
 * historical mistakes and generates a human-readable hint for the model.
 *
 * This is the "闭环" (closed loop): Mistake ↔ Immune.
 */

import type { ActivationDecision, DangerSignal, DangerSignalKind } from './immune-types.js'
import type { MistakeEntry } from './mistake-notebook.js'
import type { MistakeNotebook } from './mistake-notebook.js'

export interface ImmuneContextHint {
  level: 'warning' | 'danger' | 'ban'
  signalKinds: DangerSignalKind[]
  matchedMistakes: MistakeEntry[]
  suggestion: string
}

const SUGGESTIONS: Record<DangerSignalKind, string> = {
  compaction_fail: 'Try smaller offset/limit when re-reading files.',
  token_spike: 'Consider batching or reducing context size.',
  tool_repeat: 'The same tool call is being repeated — verify with diff before retrying.',
  prediction_error: 'Prediction mismatch detected — consider asking for clarification.',
  graph_anomaly: 'The code graph is behaving unusually — verify file structure.',
  repair_exhaustion: 'Multiple repair attempts failed — try a different approach.',
  sycophancy_detected: 'You may be in sycophancy mode — challenge assumptions.',
  tdd_violation: 'No test file touched yet. Write tests before implementation.',
  immune_hook_error: 'Immune analysis degraded — inspect recent tool and graph signals before relying on anomaly response.',
}

function severityToLevel(dangerScore: number): 'warning' | 'danger' | 'ban' {
  if (dangerScore >= 1.5) return 'ban'
  if (dangerScore >= 1.0) return 'danger'
  return 'warning'
}

/**
 * Query the MistakeNotebook for entries related to the immune activation signals.
 * Uses the signal contexts as query input.
 */
function queryRelatedMistakes(
  notebook: MistakeNotebook,
  signals: DangerSignal[],
): MistakeEntry[] {
  const allEntries: MistakeEntry[] = []
  for (const signal of signals) {
    const error = signal.context ?? signal.kind
    const ctx = `${signal.source} turn=${signal.turn}`
    const results = notebook.query(error, ctx, 2)
    for (const entry of results) {
      // dedup by id
      if (!allEntries.some(e => e.id === entry.id)) {
        allEntries.push(entry)
      }
    }
  }
  return allEntries.slice(0, 5)
}

/**
 * Generate a human-readable immune context hint.
 * Returns null if no suggestion is warranted (low confidence, no signals).
 */
export function generateImmuneContext(
  decision: ActivationDecision,
  notebook: MistakeNotebook,
  _turn: number,
): ImmuneContextHint | null {
  if (!decision.shouldActivate || decision.signals.length === 0) return null

  const signalKinds = [...new Set(decision.signals.map(s => s.kind))]
  const matchedMistakes = queryRelatedMistakes(notebook, decision.signals)
  const level = severityToLevel(decision.confidence * 2) // confidence ∈ [0,1], map to dangerScore scale

  // Build suggestion from signal kinds
  const suggestions = signalKinds
    .map(k => SUGGESTIONS[k])
    .filter(Boolean) as string[]
  const suggestion = suggestions.length > 0
    ? suggestions.join(' ')
    : 'Review recent operations for potential issues.'

  return { level, signalKinds, matchedMistakes, suggestion }
}

/**
 * Format an ImmuneContextHint as XML for injection into the system context.
 */
export function formatImmuneContext(hint: ImmuneContextHint): string {
  const lines: string[] = []

  lines.push(`<immune-signal level="${hint.level}">`)
  lines.push(`  Signals: ${hint.signalKinds.join(', ')}`)
  lines.push(`  Suggestion: ${hint.suggestion}`)

  if (hint.matchedMistakes.length > 0) {
    lines.push('  <related-mistakes>')
    for (const m of hint.matchedMistakes) {
      lines.push(`    - ${m.error}`)
      if (m.resolution) lines.push(`      Fixed by: ${m.resolution}`)
    }
    lines.push('  </related-mistakes>')
  }

  lines.push('</immune-signal>')
  return lines.join('\n')
}
