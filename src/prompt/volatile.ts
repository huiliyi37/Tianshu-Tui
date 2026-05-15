import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'

export interface VolatileContext {
  cwd: string
  rivetMd?: string
  gitStatus?: string
  workingSet?: string[]
}

function readRivetMd(cwd: string): string | undefined {
  const path = join(cwd, '.rivet.md')
  try {
    if (existsSync(path)) return readFileSync(path, 'utf-8')
  } catch { /* ignore */ }
  return undefined
}

let gitStatusCache: { value: string | undefined; timestamp: number } | null = null
const GIT_CACHE_TTL_MS = 30_000 // 30 seconds

function getGitStatus(): string | undefined {
  if (gitStatusCache && Date.now() - gitStatusCache.timestamp < GIT_CACHE_TTL_MS) {
    return gitStatusCache.value
  }

  try {
    const branch = execSync('git branch --show-current', {
      encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const status = execSync('git status --short', {
      encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (!branch && !status) return undefined
    const result = `Current branch: ${branch}\nStatus:\n${status || '(clean)'}`
    gitStatusCache = { value: result, timestamp: Date.now() }
    return result
  } catch {
    gitStatusCache = { value: undefined, timestamp: Date.now() }
    return undefined
  }
}

/** Build the volatile `<context>` block injected into the user message. */
export function buildVolatileBlock(ctx: VolatileContext): string {
  const parts: string[] = []

  const md = ctx.rivetMd ?? readRivetMd(ctx.cwd)
  if (md) {
    parts.push(`## Project Instructions\n\n${md}`)
  }

  const git = ctx.gitStatus ?? getGitStatus()
  if (git) {
    parts.push(`## Git Status\n\n${git}`)
  }

  if (ctx.workingSet && ctx.workingSet.length > 0) {
    parts.push(`## Working Set\n\n${ctx.workingSet.join('\n')}`)
  }

  return parts.length > 0 ? `<context>\n${parts.join('\n\n')}\n</context>` : ''
}
