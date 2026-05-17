import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import os from 'os'
import { gitStatusCache } from './volatile-git.js'
import type { ContextLedger } from '../context/types.js'
import type { TaskState } from '../agent/task-state.js'
import { renderActiveClaimsBlock, type ContextClaim } from '../context/claims.js'

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
  activeClaims?: ContextClaim[]
  toolHistory?: ToolHistoryEntry[]
  taskProgress?: TaskState
  behaviorMirror?: string | null
  decisions?: string[]
  strategyShift?: string | null
  repairHint?: string | null
  impactHint?: string | null
  routingReason?: string | null
  cerebellarHint?: string | null
}

let rivetMdCache = new Map<string, { value: string | undefined; timestamp: number }>()
const RIVET_MD_CACHE_TTL_MS = 30_000 // 30 seconds
const RIVET_MD_CACHE_MAX = 50

function trimCache(): void {
  if (rivetMdCache.size <= RIVET_MD_CACHE_MAX) return
  const now = Date.now()
  for (const [key, val] of rivetMdCache) {
    if (now - val.timestamp > RIVET_MD_CACHE_TTL_MS) rivetMdCache.delete(key)
  }
  while (rivetMdCache.size > RIVET_MD_CACHE_MAX) {
    const [key] = rivetMdCache.keys()
    rivetMdCache.delete(key!)
  }
}

function readRivetMd(cwd: string): string | undefined {
  const cached = rivetMdCache.get(cwd)
  if (cached && Date.now() - cached.timestamp < RIVET_MD_CACHE_TTL_MS) {
    return cached.value
  }

  const path = join(cwd, '.rivet.md')
  try {
    if (existsSync(path)) {
      const value = readFileSync(path, 'utf-8')
      rivetMdCache.set(cwd, { value, timestamp: Date.now() })
      trimCache()
      return value
    }
  } catch { /* ignore */ }
  rivetMdCache.set(cwd, { value: undefined, timestamp: Date.now() })
  trimCache()
  return undefined
}

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

const KNOWLEDGE_MAX_CHARS = 2000

function readKnowledgeFile(cwd: string): string | undefined {
  const path = join(cwd, '.rivet', 'knowledge', 'project-memory.md')
  try {
    if (existsSync(path)) {
      const content = readFileSync(path, 'utf-8').trim()
      if (!content) return undefined
      return content.length <= KNOWLEDGE_MAX_CHARS
        ? content
        : content.slice(0, KNOWLEDGE_MAX_CHARS)
    }
  } catch { /* ignore */ }
  return undefined
}

/** Build stable volatile block — excludes per-turn dynamic sections, active claims, and git status (lazy injection). */
export function buildStableVolatileBlock(ctx: VolatileContext): string {
  return buildVolatileBlockInternal({
    ...ctx,
    gitStatus: undefined,
    activeClaims: undefined,
    toolHistory: undefined,
    taskProgress: undefined,
    behaviorMirror: undefined,
    decisions: undefined,
  })
}

/** Build latest-turn volatile block — includes all sections. */
export function buildLatestTurnVolatileBlock(ctx: VolatileContext): string {
  return buildVolatileBlockInternal(ctx)
}

/** Backward-compatible alias for buildLatestTurnVolatileBlock. */
export function buildVolatileBlock(ctx: VolatileContext): string {
  return buildLatestTurnVolatileBlock(ctx)
}

function buildVolatileBlockInternal(ctx: VolatileContext): string {
  const parts: string[] = []

  parts.push(`<environment platform="${process.platform}" cwd="${escapeXml(ctx.cwd)}" os="${escapeXml(`${os.type()} ${os.release()}`)}" />`)

  const md = ctx.rivetMd ?? readRivetMd(ctx.cwd)
  if (md) {
    parts.push(`<project-instructions>\n${escapeXml(md)}\n</project-instructions>`)
  }

  // Inject project memory from previous sessions (Dream distillation)
  const knowledge = readKnowledgeFile(ctx.cwd)
  if (knowledge) {
    parts.push(`<project-memory>\n${escapeXml(knowledge)}\n</project-memory>`)
  }

  const git = ctx.gitStatus ?? gitStatusCache.get(ctx.cwd)
  if (git) {
    const lines = git.split('\n')
    const commitIdx = lines.findIndex(l => l.startsWith('Recent commits:'))
    if (commitIdx >= 0) {
      const statusPart = lines.slice(0, commitIdx).join('\n').trim()
      const commitsPart = lines.slice(commitIdx + 1).join('\n').trim()
      if (statusPart) parts.push(`<git-status>\n${escapeXml(statusPart)}\n</git-status>`)
      if (commitsPart) parts.push(`<recent-commits>\n${escapeXml(commitsPart)}\n</recent-commits>`)
    } else {
      parts.push(`<git-status>\n${escapeXml(git)}\n</git-status>`)
    }
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

  if (ctx.behaviorMirror) {
    parts.push(`<behavior-mirror>\n${escapeXml(ctx.behaviorMirror)}\n</behavior-mirror>`)
  }

  if (ctx.strategyShift) {
    parts.push(`<strategy-shift>\n${escapeXml(ctx.strategyShift)}\n</strategy-shift>`)
  }

  if (ctx.repairHint) {
    parts.push(ctx.repairHint)
  }

  if (ctx.decisions && ctx.decisions.length > 0) {
    const entries = ctx.decisions.map(d => `  <decision>${escapeXml(d)}</decision>`).join('\n')
    parts.push(`<decisions recent="${ctx.decisions.length}">\n${entries}\n</decisions>`)
  }

  if (ctx.cerebellarHint) {
    parts.push(`<cerebellar-hint>
${escapeXml(ctx.cerebellarHint)}
</cerebellar-hint>`)
  }

  if (ctx.activeClaims && ctx.activeClaims.length > 0) {
    parts.push(renderActiveClaimsBlock(ctx.activeClaims))
  }

  if (ctx.sessionMemoryBlock) {
    parts.push(ctx.sessionMemoryBlock)
  }

  return parts.length > 0 ? `<context>\n${parts.join('\n\n')}\n</context>` : ''
}
