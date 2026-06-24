/**
 * Goal completion judge.
 *
 * When the primary model self-declares "GOAL ACHIEVED", we no longer accept the
 * claim on faith. Instead we spawn a cheap read-only `goal_judge` worker that
 * independently verifies each extracted success criterion (running tests /
 * reading the real files) and returns a structured verdict. The orchestrator
 * accepts the completion only on `verified`; on `rejected` it injects the unmet
 * criteria and continues the goal loop.
 *
 * Fail-open is a hard invariant: any error, missing coordinator, skipped run, or
 * unparseable verdict degrades to `inconclusive` (which the orchestrator accepts
 * with a warning) — the judge must never trap the agent in an unbreakable loop.
 */

import type { CoordinatorRun } from './coordinator.js'

export type GoalJudgeOverall = 'verified' | 'rejected' | 'inconclusive'

export interface GoalCriterionVerdict {
  criterion: string
  /** true = met, false = not met, null = could not be checked. */
  met: boolean | null
  evidence?: string
}

export interface GoalJudgeVerdict {
  overall: GoalJudgeOverall
  criteria: GoalCriterionVerdict[]
  summary: string
}

export interface GoalJudgeInput {
  /** The goal objective the implementer was working toward. */
  objective: string
  /** Concrete success criteria (from extractGoalCriteria). */
  criteria: string[]
  /** Pre-formatted evidence snapshot (files read/modified, verifications). */
  evidence: string
  /** The implementer's final completion claim text. */
  finalClaim: string
  /** Files to scope the judge to (typically the modified files). */
  scopeFiles?: string[]
  /** When true, instruct the judge to use web_fetch/browser tools for UI/API criteria. */
  browserMode?: boolean
  signal?: AbortSignal
}

export interface GoalJudgeDeps {
  /**
   * Spawn the judge worker. Returns the coordinator run. When undefined, the
   * judge is considered unavailable and the verdict degrades to inconclusive.
   */
  spawnJudge?: (
    objective: string,
    scope: { files: string[] },
    signal?: AbortSignal,
  ) => Promise<CoordinatorRun>
  /** When true, the judge should use browser/web tools for verification. */
  browserMode?: boolean
}

function inconclusive(summary: string, criteria: string[]): GoalJudgeVerdict {
  return {
    overall: 'inconclusive',
    criteria: criteria.map(criterion => ({ criterion, met: null })),
    summary,
  }
}

/** Build the judge worker objective from the goal, criteria, evidence, and claim. */
export function buildJudgeObjective(input: GoalJudgeInput): string {
  const lines: string[] = [
    'Independently judge whether this goal is GENUINELY complete. Do not trust the implementer — verify each criterion with real tests / file reads.',
  ]
  if (input.browserMode) {
    lines.push('')
    lines.push('⚠ Browser/API verification is ENABLED. For UI or API criteria, use `web_fetch` to independently verify observable behavior (HTTP responses, page content). Do NOT rely solely on the implementer\'s assertion that a page or endpoint works.')
  }
  lines.push('')
  lines.push(`Goal: ${input.objective}`)
  lines.push('')
  lines.push('Success criteria to check (each must be independently established):')
  if (input.criteria.length > 0) {
    for (let i = 0; i < input.criteria.length; i++) {
      lines.push(`${i + 1}. ${input.criteria[i]}`)
    }
  } else {
    lines.push('(none extracted — judge whether the objective itself was genuinely handled)')
  }
  lines.push('')
  lines.push('Implementer evidence snapshot:')
  lines.push(input.evidence.trim() || '(none recorded)')
  lines.push('')
  lines.push("Implementer's final completion claim:")
  lines.push(input.finalClaim.trim() || '(none)')
  lines.push('')
  lines.push('Return the goal-judge-verdict artifact exactly as specified in your profile.')
  return lines.join('\n')
}

/**
 * Extract a {@link GoalJudgeVerdict} from arbitrary text containing a JSON
 * object with an `overall` field. Tolerant of code fences / surrounding prose.
 * Returns null when no valid verdict object is found.
 */
export function extractVerdictJson(text: string): GoalJudgeVerdict | null {
  if (!text) return null
  // Scan every balanced {...} candidate from the first '{'; pick the first that
  // parses to an object carrying a valid `overall`.
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue
    let depth = 0
    for (let j = i; j < text.length; j++) {
      if (text[j] === '{') depth++
      else if (text[j] === '}') {
        depth--
        if (depth === 0) {
          const slice = text.slice(i, j + 1)
          const verdict = tryParseVerdict(slice)
          if (verdict) return verdict
          break // move outer scan past this opening brace
        }
      }
    }
  }
  return null
}

function tryParseVerdict(slice: string): GoalJudgeVerdict | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(slice)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const obj = parsed as Record<string, unknown>
  const overall = obj.overall
  if (overall !== 'verified' && overall !== 'rejected' && overall !== 'inconclusive') return null
  const criteria: GoalCriterionVerdict[] = Array.isArray(obj.criteria)
    ? obj.criteria
        .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
        .map(c => ({
          criterion: typeof c.criterion === 'string' ? c.criterion : '',
          met: c.met === true ? true : c.met === false ? false : null,
          evidence: typeof c.evidence === 'string' ? c.evidence : undefined,
        }))
    : []
  return {
    overall,
    criteria,
    summary: typeof obj.summary === 'string' ? obj.summary : '',
  }
}

/** Pull verdict text candidates out of a coordinator run (artifacts then summaries). */
function verdictFromRun(run: CoordinatorRun, criteria: string[]): GoalJudgeVerdict | null {
  for (const result of run.results) {
    for (const artifact of result.artifacts) {
      const v = extractVerdictJson(artifact.content)
      if (v) return v
    }
  }
  for (const result of run.results) {
    const v = extractVerdictJson(result.summary)
    if (v) return v
  }
  return null
}

/**
 * Run the goal completion judge. Always resolves to a verdict (never throws
 * except on abort): unavailable / errored / unparseable → inconclusive.
 */
export async function runGoalJudge(
  deps: GoalJudgeDeps,
  input: GoalJudgeInput,
): Promise<GoalJudgeVerdict> {
  if (!deps.spawnJudge) {
    return inconclusive('goal judge unavailable (no coordinator) — accepting unverified', input.criteria)
  }
  let run: CoordinatorRun
  try {
    run = await deps.spawnJudge(
      buildJudgeObjective({ ...input, browserMode: input.browserMode ?? deps.browserMode }),
      { files: input.scopeFiles ?? [] },
      input.signal,
    )
  } catch (err) {
    if (input.signal?.aborted) throw err
    const reason = err instanceof Error ? err.message : String(err)
    return inconclusive(`goal judge spawn failed (${reason}) — accepting unverified`, input.criteria)
  }
  if (run.status === 'skipped' || run.results.length === 0) {
    return inconclusive('goal judge produced no result — accepting unverified', input.criteria)
  }
  const verdict = verdictFromRun(run, input.criteria)
  if (!verdict) {
    return inconclusive('goal judge returned no parseable verdict — accepting unverified', input.criteria)
  }
  return verdict
}
