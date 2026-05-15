import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import os from 'os'
import { gitStatusCache } from './volatile-git.js'
import type { ContextLedger } from '../context/types.js'
import type { TaskState } from '../agent/task-state.js'

export interface ToolHistoryEntry {
  tool: string
  target: string
  status: 'success' | 'failed' | 'running'
  error?: string
}

export interface VolatileContext {
  cwd: string
  rivetMd?: string
  gitStatus?: string
  workingSet?: string[]
  contextLedger?: ContextLedger
  sessionMemoryBlock?: string
  toolHistory?: ToolHistoryEntry[]
  taskProgress?: TaskState
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

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/** Build the volatile `<context>` block injected into the user message. */
export function buildVolatileBlock(ctx: VolatileContext): string {
  const parts: string[] = []

  parts.push(`<environment platform="${process.platform}" cwd="${escapeXml(ctx.cwd)}" os="${escapeXml(`${os.type()} ${os.release()}`)}" />`)

  const md = ctx.rivetMd ?? readRivetMd(ctx.cwd)
  if (md) {
    parts.push(`<project-instructions>\n${escapeXml(md)}\n</project-instructions>`)
  }

  const git = ctx.gitStatus ?? gitStatusCache.get(ctx.cwd)
  if (git) {
    parts.push(`<git-status>\n${escapeXml(git)}\n</git-status>`)
  }

  if (ctx.workingSet && ctx.workingSet.length > 0) {
    const files = ctx.workingSet.map(file => `<file>${escapeXml(file)}</file>`).join('\n')
    parts.push(`<working-set>\n${files}\n</working-set>`)
  }

  if (ctx.contextLedger) {
    const sections = ctx.contextLedger.rounds.length > 0
      ? ` rounds="${ctx.contextLedger.rounds.length}"`
      : ''
    const healthAttr = ` health="${ctx.contextLedger.tokenBudget.compactionState}"`
    const safeAttr = ` api_safe="${ctx.contextLedger.apiInvariantStatus.brokenRounds === 0}"`
    const tokensAttr = ` tokens="${ctx.contextLedger.tokenBudget.estimatedTokens}"`
    const maxAttr = ` max_tokens="${ctx.contextLedger.tokenBudget.maxTokens}"`
    parts.push(`<context-ledger${healthAttr}${safeAttr}${tokensAttr}${maxAttr}${sections} />`)
  }

  if (ctx.toolHistory && ctx.toolHistory.length > 0) {
    const entries = ctx.toolHistory.map(e => {
      const attrs = [`tool="${escapeXml(e.tool)}"`, `target="${escapeXml(e.target)}"`, `status="${e.status}"`]
      if (e.error) attrs.push(`error="${escapeXml(e.error)}"`)
      return `  <tool-summary ${attrs.join(' ')} />`
    }).join('\n')
    parts.push(`<tool-history recent="${ctx.toolHistory.length}">\n${entries}\n</tool-history>`)
  }

  if (ctx.taskProgress && ctx.taskProgress.completed.length > 0) {
    const done = ctx.taskProgress.completed.map(s => `    <done>${escapeXml(s)}</done>`).join('\n')
    const remaining = ctx.taskProgress.remaining.length > 0
      ? '\n' + ctx.taskProgress.remaining.map(s => `    <next>${escapeXml(s)}</next>`).join('\n')
      : ''
    parts.push(`<task-progress steps="${ctx.taskProgress.completed.length}" current="${escapeXml(ctx.taskProgress.current)}">\n${done}${remaining}\n  </task-progress>`)
  }

  if (ctx.sessionMemoryBlock) {
    parts.push(ctx.sessionMemoryBlock)
  }

  return parts.length > 0 ? `<context>\n${parts.join('\n\n')}\n</context>` : ''
}
