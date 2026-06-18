import type { EvidenceState } from '../evidence.js'
import type { PostSessionRuntimeHook } from '../runtime-hooks.js'
import type { TrajectoryEntry } from '../trajectory.js'
import { distillSkillDraft, persistSkillDraft } from '../skill-distill.js'

export interface SkillDistillHookDeps {
  cwd: string
  sessionId: string
  getEvidenceState: () => EvidenceState
  getDecisions: () => string[]
  getTrajectory: () => TrajectoryEntry[]
  /** Live registry skills, for dedup against already-covered ground. */
  getRegisteredSkills?: () => Array<{ name: string; triggers: RegExp[] }>
  /** Optional objective for naming/triggers. */
  getObjective?: () => string | null
}

/**
 * Skill-distill hook — postSession. Mirrors the dream hook's gating: only
 * sessions that produced verified, repeatable procedures get distilled into a
 * SKILL.md draft under `.rivet/skills/_drafts/`. Drafts are review-only — they
 * never enter the discovery block until the user approves them.
 */
export function createSkillDistillHook(deps: SkillDistillHookDeps): PostSessionRuntimeHook {
  return {
    phase: 'postSession',
    name: 'skill-distill',
    run() {
      const evidence = deps.getEvidenceState()
      // Cheap pre-gate (same spirit as dream): need a passed verification AND
      // some modified files — distillSkillDraft applies the full gate.
      const hasPassed = evidence.verifications.some(v => v.status === 'passed')
      if (!hasPassed || evidence.filesModified.size === 0) return

      const input = {
        sessionId: deps.sessionId,
        objective: deps.getObjective?.() ?? null,
        decisions: deps.getDecisions(),
        trajectory: deps.getTrajectory(),
        verifications: evidence.verifications,
        filesModified: [...evidence.filesModified],
        existingSkills: deps.getRegisteredSkills?.() ?? [],
      }

      const draft = distillSkillDraft(input)
      if (!draft) return

      const cwd = deps.cwd
      setImmediate(() => {
        try { persistSkillDraft(cwd, draft) } catch { /* best-effort, never break session close */ }
      })
    },
  }
}
