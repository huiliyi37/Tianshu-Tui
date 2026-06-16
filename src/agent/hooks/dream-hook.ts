import type { EvidenceState } from '../evidence.js'
import { persistDream, cleanupProjectMemory } from '../dream.js'
import type { TrajectoryEntry as DreamTrajectoryEntry } from '../dream.js'
import type { TrajectoryEntry } from '../trajectory.js'
import type { PostSessionRuntimeHook } from '../runtime-hooks.js'
import type { FailureJournal } from '../failure-journal.js'
import { distillFromFailures } from '../playbook.js'
import type { PlaybookStore } from '../playbook-store.js'

export interface DreamHookDeps {
  cwd: string
  sessionId: string
  getEvidenceState: () => EvidenceState
  getDecisions: () => string[]
  getTrajectory: () => TrajectoryEntry[]
  getFailureJournal?: () => FailureJournal
  getPlaybookStore?: () => PlaybookStore | undefined
}

function toDreamTrajectoryEntry(entry: TrajectoryEntry): DreamTrajectoryEntry {
  return {
    tool: entry.tool,
    target: entry.target,
    status: entry.status.startsWith('retried') || entry.status === 'success' ? 'success' : 'failed',
    error: entry.errorClass,
  }
}

export function createDreamHook(deps: DreamHookDeps): PostSessionRuntimeHook {
  return {
    phase: 'postSession',
    name: 'dream-distill',
    run() {
      // Experience distillation runs unconditionally — short sessions with
      // failures should still sediment diagnostic patterns into playbook.
      const journal = deps.getFailureJournal?.()
      const store = deps.getPlaybookStore?.()
      if (journal && store) {
        const entries = journal.getEntries()
        if (entries.length > 0) {
          const patterns = journal.detectPatterns()
          const bullets = distillFromFailures(entries, patterns)
          if (bullets.length > 0) {
            store.addBullets(bullets)
          }
        }
      }

      const evidenceState = deps.getEvidenceState()
      const hasPassedTests = evidenceState.verifications.some(v => v.status === 'passed')
      const hasEnoughFiles = evidenceState.filesModified.size >= 3
      if (!hasPassedTests && !hasEnoughFiles) return

      const cwd = deps.cwd
      const input = {
        filesModified: [...evidenceState.filesModified],
        filesRead: [...evidenceState.filesRead],
        verifications: evidenceState.verifications,
        decisions: deps.getDecisions(),
        trajectoryEntries: deps.getTrajectory().map(toDreamTrajectoryEntry),
        sessionId: deps.sessionId,
      }
      setImmediate(() => {
        cleanupProjectMemory(cwd)
        persistDream(cwd, input)
      })
    },
  }
}
