/**
 * Snapshot verification policy (VSW P4) — §6 adaptive condition matrix
 *
 * Pure decision: should verification run in an isolated snapshot worktree, or
 * in-place in the live working tree? Snapshotting costs a worktree build, so we
 * only pay it when the live tree is a provable pollution risk:
 *
 *   shouldSnapshot =
 *     isGitRepo && (
 *       sameCwdRunningSessions >= 1            // another running session, same cwd
 *       || preExistingDirtyCount > 0
 *       || preExistingUntrackedCount > 0
 *     )
 *
 * A user `--snapshot` flag forces snapshotting (still requires a git repo with a
 * baseline commit — worktrees only exist in git, and we must not fake-green by
 * pretending to snapshot when we cannot build the tree).
 *
 * @module snapshot-policy
 */

export type SnapshotMode = 'snapshot' | 'in-place' | 'in-place-degraded'

export interface SnapshotPolicyInput {
  /** Is the working directory inside a git repository? */
  isGitRepo: boolean
  /** Real baseline commit-ish (BaselineSnapshot.head). Absent on paths that
   *  never captured a baseline (e.g. some standalone TUI starts). */
  baselineHead?: string
  /** Count of OTHER running sessions sharing this cwd (excludes self). */
  sameCwdRunningSessions: number
  /** Pre-existing tracked-dirty files at baseline capture. */
  preExistingDirtyCount: number
  /** Pre-existing untracked files at baseline capture. */
  preExistingUntrackedCount: number
  /** User-forced snapshot (e.g. `--snapshot`). */
  forceSnapshot?: boolean
}

export interface SnapshotDecision {
  /** Final answer: run verification in a snapshot worktree? */
  snapshot: boolean
  mode: SnapshotMode
  /** Human-readable rationale (surfaced to the user / trace). */
  reason: string
}

function wantsSnapshot(input: SnapshotPolicyInput): boolean {
  if (input.forceSnapshot) return true
  return input.sameCwdRunningSessions >= 1
    || input.preExistingDirtyCount > 0
    || input.preExistingUntrackedCount > 0
}

/**
 * Decide the verification strategy. Never throws. Degrades to in-place (with a
 * stated reason) whenever snapshotting is wanted but cannot be performed —
 * non-git repo or missing baseline commit — so callers never fake-green.
 */
export function decideSnapshotPolicy(input: SnapshotPolicyInput): SnapshotDecision {
  const wanted = wantsSnapshot(input)

  if (!input.isGitRepo) {
    return {
      snapshot: false,
      mode: 'in-place-degraded',
      reason: wanted
        ? 'Snapshot wanted (pollution risk) but the directory is not a git repository — worktree isolation unavailable. Verifying in-place; treat results as a delivery caveat.'
        : 'Not a git repository — verifying in-place.',
    }
  }

  if (!wanted) {
    return {
      snapshot: false,
      mode: 'in-place',
      reason: 'Single clean session: no concurrent sessions and a clean baseline — verifying in-place to skip worktree overhead.',
    }
  }

  if (!input.baselineHead || input.baselineHead.trim().length === 0) {
    return {
      snapshot: false,
      mode: 'in-place-degraded',
      reason: 'Snapshot wanted but no baseline commit is available — cannot build an isolated worktree. Verifying in-place; treat results as a delivery caveat.',
    }
  }

  return {
    snapshot: true,
    mode: 'snapshot',
    reason: snapshotReason(input),
  }
}

function snapshotReason(input: SnapshotPolicyInput): string {
  if (input.forceSnapshot) return 'User forced snapshot isolation (--snapshot).'
  const parts: string[] = []
  if (input.sameCwdRunningSessions >= 1) {
    parts.push(`${input.sameCwdRunningSessions} concurrent session(s) on this directory`)
  }
  if (input.preExistingDirtyCount > 0) {
    parts.push(`${input.preExistingDirtyCount} pre-existing dirty file(s)`)
  }
  if (input.preExistingUntrackedCount > 0) {
    parts.push(`${input.preExistingUntrackedCount} pre-existing untracked file(s)`)
  }
  return `Verifying in an isolated snapshot worktree because of pollution risk: ${parts.join(', ')}.`
}
