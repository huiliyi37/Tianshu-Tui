import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { gitStatusCache } from './volatile-git.js'

export interface VolatileContext {
  cwd: string
  rivetMd?: string
  gitStatus?: string
  workingSet?: string[]
}

let rivetMdCache: { value: string | undefined; timestamp: number } | null = null
const RIVET_MD_CACHE_TTL_MS = 30_000 // 30 seconds

function readRivetMd(cwd: string): string | undefined {
  if (rivetMdCache && Date.now() - rivetMdCache.timestamp < RIVET_MD_CACHE_TTL_MS) {
    return rivetMdCache.value
  }

  const path = join(cwd, '.rivet.md')
  try {
    if (existsSync(path)) {
      const value = readFileSync(path, 'utf-8')
      rivetMdCache = { value, timestamp: Date.now() }
      return value
    }
  } catch { /* ignore */ }
  rivetMdCache = { value: undefined, timestamp: Date.now() }
  return undefined
}

/** Build the volatile `<context>` block injected into the user message. */
export function buildVolatileBlock(ctx: VolatileContext): string {
  const parts: string[] = []

  const md = ctx.rivetMd ?? readRivetMd(ctx.cwd)
  if (md) {
    parts.push(`## Project Instructions\n\n${md}`)
  }

  const git = ctx.gitStatus ?? gitStatusCache.get(ctx.cwd)
  if (git) {
    parts.push(`## Git Status\n\n${git}`)
  }

  if (ctx.workingSet && ctx.workingSet.length > 0) {
    parts.push(`## Working Set\n\n${ctx.workingSet.join('\n')}`)
  }

  return parts.length > 0 ? `<context>\n${parts.join('\n\n')}\n</context>` : ''
}
