import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { gitStatusCache } from './volatile-git.js'
import { summarizeGitStatus } from './git-status-summary.js'
import { loadProjectMemory } from '../context/project-memory-loader.js'
import { renderResidentCapsuleBlock } from '../agent/seed-capsule-store.js'
import { generateCodebaseIndexBlock, getHeadSha } from '../repo/codebase-index.js'
import { detectCwdRelation } from './self-recognition.js'
import type { VolatileContext } from './volatile.js'

export interface SnapshotInput {
  cwd: string
  getGitStatus?: () => string | undefined
  rivetMd?: string
  sessionMemoryBlock?: string
  workingSet?: string[]
  activeDomain?: VolatileContext['activeDomain']
  projectMemoryBlock?: string
  /** Optional pre-built codebase index block. If not provided, generated from MeridianDB. */
  projectIndexBlock?: string
  /** Optional MeridianDb instance for codebase index generation. */
  meridianDb?: import('../repo/meridian-db.js').MeridianDb
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

  const projectMemoryBlock = input.projectMemoryBlock ?? loadProjectMemory(input.cwd).content

  // 常驻注入：核心护栏置顶 + 5 星 principles 全文。行为护栏必须常驻——
  // 撤入 recall 后行动跑偏（V3.1 回归）。ledger 仍经 recall_capsule 按需拉取。
  const seedCapsuleBlock = renderResidentCapsuleBlock(input.cwd)

  // Codebase index — generated from MeridianDB at snapshot time.
  // Frozen: placed in stable prefix alongside projectMemoryBlock.
  const projectIndexBlock = input.projectIndexBlock ?? (
    input.meridianDb
      ? generateCodebaseIndexBlock(input.meridianDb, getHeadSha())
      : undefined
  )

  return Object.freeze({
    cwd: input.cwd,
    cwdRelation: detectCwdRelation(input.cwd),
    rivetMd,
    gitStatus,
    workingSet,
    activeDomain: input.activeDomain ?? undefined,
    sessionMemoryBlock: input.sessionMemoryBlock,
    projectMemoryBlock,
    seedCapsuleBlock,
    projectIndexBlock,
  }) as VolatileContext
}
