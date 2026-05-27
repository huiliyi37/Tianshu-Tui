import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
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

function readRivetMdOnce(cwd: string): string | undefined {
  // Load AGENTS.md (architecture map) + .rivet.md (operating manual)
  const parts: string[] = []
  const agentsPath = join(cwd, 'AGENTS.md')
  const rivetPath = join(cwd, '.rivet.md')
  try {
    if (existsSync(agentsPath)) parts.push(readFileSync(agentsPath, 'utf-8'))
  } catch { /* ignore */ }
  try {
    if (existsSync(rivetPath)) parts.push(readFileSync(rivetPath, 'utf-8'))
  } catch { /* ignore */ }
  return parts.length > 0 ? parts.join('\n\n') : undefined
}

export function createVolatileSnapshot(input: SnapshotInput): VolatileContext {
  const rawGit = input.getGitStatus
    ? input.getGitStatus()
    : gitStatusCache.get(input.cwd)
  const gitStatus = rawGit ? summarizeGitStatus(rawGit) : undefined

  const rivetMd = input.rivetMd ?? readRivetMdOnce(input.cwd)

  const workingSet = input.workingSet
    ? Object.freeze([...input.workingSet])
    : undefined

  return Object.freeze({
    cwd: input.cwd,
    rivetMd,
    gitStatus,
    workingSet,
    activeDomain: input.activeDomain ?? undefined,
    sessionMemoryBlock: input.sessionMemoryBlock,
  }) as VolatileContext
}
