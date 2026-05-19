import { gitStatusCache } from './volatile-git.js'
import { summarizeGitStatus } from './git-status-summary.js'
import type { VolatileContext } from './volatile.js'

export interface SnapshotInput {
  cwd: string
  getGitStatus?: () => string | undefined
  rivetMd?: string
  sessionMemoryBlock?: string
  workingSet?: string[]
  activeDomain?: VolatileContext['activeDomain']
}

export function createVolatileSnapshot(input: SnapshotInput): VolatileContext {
  const rawGit = input.getGitStatus
    ? input.getGitStatus()
    : gitStatusCache.get(input.cwd)
  const gitStatus = rawGit ? summarizeGitStatus(rawGit) : undefined

  const workingSet = input.workingSet
    ? Object.freeze([...input.workingSet])
    : undefined

  // Cast: Object.freeze produces readonly arrays but VolatileContext
  // declares mutable arrays. Runtime immutability is still enforced.
  return Object.freeze({
    cwd: input.cwd,
    rivetMd: input.rivetMd,
    gitStatus,
    workingSet,
    activeDomain: input.activeDomain ?? undefined,
    sessionMemoryBlock: input.sessionMemoryBlock,
  }) as VolatileContext
}
