import type { EvidenceState } from '../evidence.js'
import { persistDream } from '../dream.js'
import type { TrajectoryEntry as DreamTrajectoryEntry } from '../dream.js'
import type { TrajectoryEntry } from '../trajectory.js'
import type { PostSessionRuntimeHook } from '../runtime-hooks.js'

export interface DreamHookDeps {
  cwd: string
  sessionId: string
  getEvidenceState: () => EvidenceState
  getDecisions: () => string[]
  getTrajectory: () => TrajectoryEntry[]
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
      const evidenceState = deps.getEvidenceState()
      const hasPassedTests = evidenceState.verifications.some(v => v.status === 'passed')
      const hasEnoughFiles = evidenceState.filesModified.size >= 3
      if (!hasPassedTests && !hasEnoughFiles) return

      // Defer sync I/O off the critical path so onTurnComplete fires without
      // blocking on readFileSync + writeFileAtomicSync (~1-50ms depending on
      // knowledge file size and filesystem). persistDream is fire-and-forget;
      // failures are logged by writeFileAtomicSync internally.
      const cwd = deps.cwd
      const input = {
        filesModified: [...evidenceState.filesModified],
        filesRead: [...evidenceState.filesRead],
        verifications: evidenceState.verifications,
        decisions: deps.getDecisions(),
        trajectoryEntries: deps.getTrajectory().map(toDreamTrajectoryEntry),
        sessionId: deps.sessionId,
      }
      setImmediate(() => persistDream(cwd, input))
    },
  }
}
