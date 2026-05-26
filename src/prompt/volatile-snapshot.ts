import { readFileSync, existsSync, readdirSync } from 'fs'
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
  modelSubstrate?: { provider: string; model: string }
}

const KNOWLEDGE_MAX_CHARS = 2000

function readRivetMdOnce(cwd: string): string | undefined {
  const path = join(cwd, '.rivet.md')
  try {
    return existsSync(path) ? readFileSync(path, 'utf-8') : undefined
  } catch { return undefined }
}

function readKnowledgeOnce(cwd: string): string | undefined {
  const dir = join(cwd, '.rivet', 'knowledge')
  try {
    if (!existsSync(dir)) return undefined
    const files = readdirSync(dir).filter(f => f.endsWith('.md'))
    if (files.length === 0) return undefined
    files.sort((a, b) => (a === 'project-memory.md' ? -1 : b === 'project-memory.md' ? 1 : a.localeCompare(b)))
    let combined = ''
    for (const file of files) {
      const content = readFileSync(join(dir, file), 'utf-8').trim()
      if (!content) continue
      if (combined.length + content.length + 10 > KNOWLEDGE_MAX_CHARS) break
      combined += (combined ? `\n\n<!-- ${file} -->\n` : '') + content
    }
    return combined || undefined
  } catch { return undefined }
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
    modelSubstrate: input.modelSubstrate,
    _knowledgeSnapshot: readKnowledgeOnce(input.cwd),
  }) as VolatileContext
}
