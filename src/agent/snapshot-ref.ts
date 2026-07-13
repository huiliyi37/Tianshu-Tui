/**
 * Snapshot reference identity (VSW P2)
 *
 * A snapshotRef uniquely identifies the tree a verification ran against:
 *   snapshotRef = <baselineHead> + sha(owned diff)
 *
 * When the owned diff changes (the session edits more files), the ref changes,
 * so a verification recorded under an old ref is provably stale — the gate must
 * not count it. This is the "改动即失效旧验证" supersession signal, made into a
 * content-addressed identity rather than a wall-clock heuristic.
 *
 * @module snapshot-ref
 */

import { spawnGitSync } from '../tools/spawn-git.js'
import { createHash } from 'node:crypto'

/**
 * Compute a stable snapshot reference from the baseline commit and the owned
 * diff text. Pure — callers obtain the diff however they like (see
 * computeOwnedDiff for the git-backed helper).
 */
export function computeSnapshotRef(baselineHead: string, ownedDiff: string): string {
  const head = (baselineHead || '0').trim().slice(0, 12)
  const diffHash = createHash('sha256').update(ownedDiff).digest('hex').slice(0, 12)
  return `${head}+${diffHash}`
}

/**
 * Owned diff text = `git diff <baselineHead> -- <ownedFiles>` run in baseCwd.
 * Captures tracked owned modifications/deletions (untracked-new files do not
 * appear in git diff and are intentionally excluded from the ref — they are
 * fully described by their copied content in the snapshot tree). Returns '' on
 * any failure or when there are no owned files, which still yields a stable ref.
 */
export function computeOwnedDiff(baseCwd: string, baselineHead: string, ownedFiles: string[]): string {
  if (!baselineHead || ownedFiles.length === 0) return ''
  const result = spawnGitSync(['diff', '--no-color', baselineHead, '--', ...ownedFiles], {
    cwd: baseCwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.status !== 0) return ''
  return typeof result.stdout === 'string' ? result.stdout : ''
}

/** Convenience: compute the snapshotRef directly from a git repo + owned files. */
export function snapshotRefFor(baseCwd: string, baselineHead: string, ownedFiles: string[]): string {
  return computeSnapshotRef(baselineHead, computeOwnedDiff(baseCwd, baselineHead, ownedFiles))
}
