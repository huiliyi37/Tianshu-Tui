/**
 * VerificationSnapshotManager — session-scoped VSW orchestration (VSW P3/P4)
 *
 * One snapshot per session, created lazily on first verification that the §6
 * policy says should be isolated. Subsequent verifications reuse the worktree
 * and only rebuild when the owned diff changes (snapshotRef differs). On
 * session end / deliver, the worktree is destroyed.
 *
 * This is the brain that decides (decideSnapshotPolicy) and builds
 * (createVerificationSnapshot); run_tests consumes the resulting plan to run
 * Phase A (isolated) in the snapshot and Phase B (integration) in the live tree.
 *
 * An orphan reaper removes stale VSW worktrees left by dead sessions — each
 * snapshot records its owner pid so the reaper can probe liveness rather than
 * guess by age.
 *
 * @module verification-snapshot-manager
 */

import { writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createVerificationSnapshot,
  snapshotPath,
  type VerificationSnapshot,
} from './verification-snapshot.js'
import { decideSnapshotPolicy, type SnapshotDecision } from './snapshot-policy.js'
import { snapshotRefFor } from './snapshot-ref.js'
import { isPidAlive } from './repo-lock.js'
import { removeWorktree } from './worktree.js'

export interface VerificationSnapshotPlan {
  path: string
  snapshotRef: string
  decision: SnapshotDecision
}

export interface VerificationSnapshotManagerInit {
  baseCwd: string
  sessionId: string
  baselineHead?: string
  isGitRepo: boolean
  preExistingDirtyCount: number
  preExistingUntrackedCount: number
  /** Live count of OTHER running sessions on this cwd (excludes self). */
  sameCwdRunningSessions: () => number
  forceSnapshot?: boolean
  /** Injectable for tests; defaults to the real createVerificationSnapshot. */
  createSnapshot?: typeof createVerificationSnapshot
  /** Injectable for tests; defaults to git-backed snapshotRefFor. */
  computeRef?: (baseCwd: string, baselineHead: string, ownedFiles: string[]) => string
}

export interface VerificationSnapshotManager {
  /** Decide + lazily build/refresh the snapshot for the given owned files.
   *  Returns a plan when snapshot mode is active, or null for in-place. */
  prepare(ownedFiles: string[]): VerificationSnapshotPlan | null
  /** Most recent policy decision (surfaces the reason even when in-place). */
  lastDecision(): SnapshotDecision | null
  /** Current active snapshotRef, or undefined when not snapshotting. */
  currentSnapshotRef(): string | undefined
  /** Tear down the worktree and owner marker. */
  destroy(): void
}

const OWNER_FILE = '.vsw-owner.json'

function writeOwnerMarker(path: string, sessionId: string): void {
  try {
    writeFileSync(join(path, OWNER_FILE), JSON.stringify({ pid: process.pid, sessionId }), 'utf-8')
  } catch {
    // best-effort — reaper falls back to leaving the dir if it can't read ownership
  }
}

export function createVerificationSnapshotManager(
  init: VerificationSnapshotManagerInit,
): VerificationSnapshotManager {
  const createSnapshot = init.createSnapshot ?? createVerificationSnapshot
  const computeRef = init.computeRef ?? snapshotRefFor

  let snapshot: VerificationSnapshot | null = null
  let activeRef: string | undefined
  let decision: SnapshotDecision | null = null

  function prepare(ownedFiles: string[]): VerificationSnapshotPlan | null {
    decision = decideSnapshotPolicy({
      isGitRepo: init.isGitRepo,
      baselineHead: init.baselineHead,
      sameCwdRunningSessions: init.sameCwdRunningSessions(),
      preExistingDirtyCount: init.preExistingDirtyCount,
      preExistingUntrackedCount: init.preExistingUntrackedCount,
      forceSnapshot: init.forceSnapshot,
    })

    if (!decision.snapshot) {
      // Policy says in-place. If a snapshot existed from an earlier (e.g. forced)
      // decision, leave it; destroy() handles teardown at session end.
      return null
    }

    const baselineHead = init.baselineHead as string // guaranteed non-empty by policy
    const ref = computeRef(init.baseCwd, baselineHead, ownedFiles)

    if (!snapshot) {
      snapshot = createSnapshot({
        baseCwd: init.baseCwd,
        sessionId: init.sessionId,
        baselineHead,
        ownedFiles,
      })
      writeOwnerMarker(snapshot.path, init.sessionId)
    } else if (ref !== activeRef) {
      // Owned diff changed → rebuild so verification runs on current owned content.
      snapshot.refresh(ownedFiles)
    }
    activeRef = ref

    return { path: snapshot.path, snapshotRef: ref, decision }
  }

  return {
    prepare,
    lastDecision: () => decision,
    currentSnapshotRef: () => activeRef,
    destroy(): void {
      if (snapshot) {
        snapshot.destroy()
        snapshot = null
      }
      activeRef = undefined
    },
  }
}

export interface ReapOrphanSnapshotsResult {
  reaped: string[]
  kept: string[]
}

/**
 * Remove VSW worktrees owned by dead sessions. Scans `.rivet/vsw/*`, reads each
 * dir's owner marker, and reaps when the owner pid is not alive. Never reaps the
 * current session or dirs whose ownership cannot be read (fail safe). `isAlive`
 * is injectable for tests.
 */
export function reapOrphanSnapshots(opts: {
  baseCwd: string
  currentSessionId?: string
  isAlive?: (pid: number) => boolean
  removeWorktreeDir?: (baseCwd: string, dir: string) => void
}): ReapOrphanSnapshotsResult {
  const isAlive = opts.isAlive ?? isPidAlive
  const root = join(opts.baseCwd, '.rivet', 'vsw')
  const reaped: string[] = []
  const kept: string[] = []
  if (!existsSync(root)) return { reaped, kept }

  let entries: string[] = []
  try {
    entries = readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)
  } catch {
    return { reaped, kept }
  }

  for (const sessionId of entries) {
    if (opts.currentSessionId && sessionId === opts.currentSessionId) {
      kept.push(sessionId)
      continue
    }
    const dir = snapshotPath(opts.baseCwd, sessionId)
    const markerPath = join(dir, OWNER_FILE)
    let pid: number | undefined
    try {
      const raw = JSON.parse(readFileSync(markerPath, 'utf-8')) as { pid?: unknown }
      if (typeof raw.pid === 'number') pid = raw.pid
    } catch {
      // No readable marker → cannot prove the owner is dead → keep (fail safe).
      kept.push(sessionId)
      continue
    }
    if (pid !== undefined && !isAlive(pid)) {
      reapDir(opts.baseCwd, dir, opts.removeWorktreeDir)
      reaped.push(sessionId)
    } else {
      kept.push(sessionId)
    }
  }

  return { reaped, kept }
}

function reapDir(baseCwd: string, dir: string, custom?: (baseCwd: string, dir: string) => void): void {
  if (custom) {
    custom(baseCwd, dir)
    return
  }
  try {
    removeWorktree(baseCwd, dir)
  } catch {
    // owner is dead; registration may be stale — fall through to dir scrub.
  }
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // best-effort
  }
}

/**
 * Reap orphaned Hands worktrees left by dead sessions. Scans /tmp for
 * `rivet-wt-*` directories, reads each dir's owner marker, and reaps when
 * the owner pid is not alive. Does not reap the current session's worktrees.
 *
 * Unlike VSW snapshots (`.rivet/vsw/*`), Hands worktrees live in `/tmp`
 * and are not under the project root, so the existing `reapOrphanSnapshots`
 * scanner does not find them.
 */
export function reapOrphanHandsWorktrees(opts: {
  baseCwd: string
  currentSessionId?: string
  isAlive?: (pid: number) => boolean
  removeWorktreeDir?: (baseCwd: string, dir: string) => void
}): ReapOrphanSnapshotsResult {
  const isAlive = opts.isAlive ?? isPidAlive
  const reaped: string[] = []
  const kept: string[] = []
  const tmpRoot = tmpdir()
  const prefix = 'rivet-wt-'

  let entries: string[] = []
  try {
    entries = readdirSync(tmpRoot, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name.startsWith(prefix))
      .map(e => e.name)
  } catch {
    return { reaped, kept }
  }

  for (const entryName of entries) {
    const dir = join(tmpRoot, entryName)
    const markerPath = join(dir, OWNER_FILE)
    let pid: number | undefined
    let sessionId: string | undefined
    try {
      const raw = JSON.parse(readFileSync(markerPath, 'utf-8')) as { pid?: unknown; sessionId?: unknown }
      if (typeof raw.pid === 'number') pid = raw.pid
      if (typeof raw.sessionId === 'string') sessionId = raw.sessionId
    } catch {
      // No readable marker — cannot prove dead → keep (fail safe).
      kept.push(entryName)
      continue
    }
    if (opts.currentSessionId && sessionId === opts.currentSessionId) {
      kept.push(entryName)
      continue
    }
    if (pid !== undefined && !isAlive(pid)) {
      reapDir(opts.baseCwd, dir, opts.removeWorktreeDir)
      reaped.push(entryName)
    } else {
      kept.push(entryName)
    }
  }

  return { reaped, kept }
}
